import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE = makePaneKey('external-live', '11111111-1111-4111-8111-111111111111')
const PROVIDER_SESSION = { key: 'session_id' as const, id: 'session-live' }

function seedLocalIdentity(server: AgentHookServer): void {
  server.ingestRemote(
    {
      paneKey: PANE,
      providerSession: PROVIDER_SESSION,
      payload: { state: 'working', prompt: 'test', agentType: 'gemini' }
    },
    'seed-connection'
  )
  server.ingestTerminalStatus({
    paneKey: PANE,
    connectionId: null,
    payload: { state: 'working', prompt: 'test', agentType: 'gemini' }
  })
}

describe('AgentHookServer AI Vault liveness identity', () => {
  it('retains provider identity after a live row is dismissed', () => {
    const server = new AgentHookServer()
    seedLocalIdentity(server)
    server.dropStatusEntry(PANE)

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        connectionId: null,
        providerSession: PROVIDER_SESSION,
        providerSessionOnly: true
      })
    ])
    expect(server.getStatusChangeSnapshot()).toEqual([])
  })

  it('hydrates dismissed provider identity without reviving visible status', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-ai-vault-liveness-'))
    const first = new AgentHookServer()
    try {
      await first.start({ env: 'production', userDataPath })
      seedLocalIdentity(first)
      first.dropStatusEntry(PANE)
      first.flushStatusPersistSync()
      first.stop()

      const second = new AgentHookServer()
      await second.start({ env: 'production', userDataPath })
      try {
        expect(second.getStatusSnapshot()).toEqual([
          expect.objectContaining({
            providerSession: PROVIDER_SESSION,
            providerSessionOnly: true,
            restoredUnconfirmed: true
          })
        ])
        expect(second.getStatusChangeSnapshot()).toEqual([])
      } finally {
        second.stop()
      }
    } finally {
      first.stop()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })
})
