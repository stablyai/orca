import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { normalizeHookPayload } from '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { InProcessAgentIdentityClient } from '../../../identity/agent-identity-client.test-fixtures'
import type { AgentIdentityClient } from '../../../identity/agent-identity-worker-client'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody } from '../server.test-fixtures'

const WSL = 'wsl:Ubuntu'
const PANE = makePaneKey('tab-0', '00000000-0000-4000-8000-000000000000')
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

class IdentityTestServer extends AgentHookServer {
  readonly identityClient = new InProcessAgentIdentityClient()

  protected override createAgentIdentityClient(): AgentIdentityClient {
    return this.identityClient
  }

  moveStatusFile(path: string): void {
    this.setStatusFilePath(path)
  }
}

function hook(sessionId: string, transcriptPath: string) {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        transcript_path: transcriptPath,
        prompt: 'task'
      },
      { paneKey: PANE, tabId: 'tab-0' }
    ),
    'production'
  )
  if (!event) {
    throw new Error('hook was rejected')
  }
  return event
}

async function started(): Promise<IdentityTestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-transcript-source-'))
  const server = new IdentityTestServer()
  cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.unshift(() => server.stop())
  await server.start({ env: 'production', userDataPath: dir })
  return server
}

const answered = () => new Promise((resolve) => setImmediate(resolve))

it('reads a terminal agent by its own conversation, never by the pane it was attributed to', async () => {
  const server = await started()
  server.ingestRemote(hook('session-a', '/home/u/.claude/projects/p/a.jsonl'), WSL)
  await answered()
  const first = server.getStatusSnapshot()[0]?.orcaSessionId
  // Another agent's hooks land on the same pane, as in the split-pane misattribution.
  server.ingestRemote(hook('session-b', '/home/u/.claude/projects/p/b.jsonl'), WSL)
  await answered()
  const second = server.getStatusSnapshot()[0]?.orcaSessionId
  expect(first).toMatch(/^claude_/)
  expect(second).toMatch(/^claude_/)
  expect(second).not.toBe(first)

  expect(await server.terminalAgentTranscriptSource(second!, () => ({}))).toMatchObject({
    key: { wslDistro: 'Ubuntu', agent: 'claude', providerSessionId: 'session-b' },
    providerSession: { id: 'session-b', transcriptPath: '/home/u/.claude/projects/p/b.jsonl' }
  })
  // The first conversation's pane now shows the second: it has no transcript location, not b's.
  expect(await server.terminalAgentTranscriptSource(first!, () => ({}))).toBeNull()
  expect(await server.terminalAgentIdsOfProviderSession('session-a')).toEqual([first])
})

it.skipIf(process.platform === 'win32')(
  "finds a dormant agent's transcript only through a sleeping record naming its conversation",
  async () => {
    const server = await started()
    server.ingestRemote(hook('session-a', '/home/u/.claude/projects/p/a.jsonl'), WSL)
    await answered()
    const id = server.getStatusSnapshot()[0]?.orcaSessionId
    server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
    const sleeping = (sessionId: string) => ({
      agent: 'claude' as const,
      providerSession: {
        key: 'session_id' as const,
        id: sessionId,
        transcriptPath: `/home/u/.claude/projects/p/${sessionId}.jsonl`
      },
      connectionId: WSL
    })

    expect(
      await server.terminalAgentTranscriptSource(id!, () => ({ other: sleeping('other') }))
    ).toBeNull()
    let partitionReads = 0
    const records = () => {
      partitionReads++
      return { other: sleeping('other'), a: sleeping('session-a') }
    }
    server.identityClient.providerKeyRequests = 0
    const found = await server.terminalAgentTranscriptSource(id!, records)
    expect(found).toMatchObject({
      key: { wslDistro: 'Ubuntu', providerSessionId: 'session-a' },
      providerSession: { transcriptPath: '/home/u/.claude/projects/p/session-a.jsonl' }
    })
    // The post-read recheck reuses the answer it was given: one partition read, no store question.
    expect(await server.terminalAgentTranscriptSource(id!, records, found!)).toEqual(found)
    expect(server.identityClient.providerKeyRequests).toBe(1)
    expect(partitionReads).toBe(2)
  }
)

it('reads a native Windows agent asleep by its own record, never a WSL record of the same conversation', async () => {
  const platform = process.platform
  const server = await started()
  const nativePath = 'C:\\Users\\u\\.claude\\projects\\p\\x.jsonl'
  const guestPath = '/home/u/.claude/projects/p/x.jsonl'
  // One provider conversation resumed natively and in WSL: two keys, two Orca IDs.
  server.ingestRemote(hook('session-x', nativePath), null)
  await answered()
  const native = server.getStatusSnapshot()[0]?.orcaSessionId
  server.ingestRemote(hook('session-x', guestPath), WSL)
  await answered()
  const wsl = server.getStatusSnapshot()[0]?.orcaSessionId
  expect(wsl).not.toBe(native)
  server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
  // Sleeping records carry no distro: both look native.
  const asleep = (path: string) => ({
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id: 'session-x', transcriptPath: path },
    connectionId: null
  })
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    for (const records of [
      { guest: asleep(guestPath), native: asleep(nativePath) },
      { native: asleep(nativePath), guest: asleep(guestPath) }
    ]) {
      expect(await server.terminalAgentTranscriptSource(native!, () => records)).toMatchObject({
        key: { wslDistro: '' },
        providerSession: { transcriptPath: nativePath }
      })
      expect(await server.terminalAgentTranscriptSource(wsl!, () => records)).toBeNull()
    }
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }
})

it.skipIf(process.platform === 'win32')(
  'never carries a key past the store that vouched for it, and looks up a sleeping conversation by its own key',
  async () => {
    const server = await started()
    server.ingestRemote(hook('session-a', '/home/u/.claude/projects/p/a.jsonl'), WSL)
    await answered()
    const id = server.getStatusSnapshot()[0]?.orcaSessionId
    server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
    const sleeping = (sessionId: string) => ({
      agent: 'claude' as const,
      providerSession: {
        key: 'session_id' as const,
        id: sessionId,
        transcriptPath: `/home/u/.claude/projects/p/${sessionId}.jsonl`
      },
      connectionId: WSL
    })
    for (const population of [300, 3_000]) {
      let visits = 0
      const records: Record<string, ReturnType<typeof sleeping>> = {}
      for (let index = 0; index < population; index++) {
        const record = sleeping(`other-${index}`)
        records[`pane-${index}`] = {
          ...record,
          get providerSession() {
            visits++
            return record.providerSession
          }
        }
      }
      records.a = sleeping('session-a')
      const found = await server.terminalAgentTranscriptSource(id!, () => records)
      visits = 0
      for (let read = 0; read < 10; read++) {
        expect(await server.terminalAgentTranscriptSource(id!, () => records, found!)).toEqual(
          found
        )
      }
      // Ten rechecks touch only the asked conversation's records, however many others sleep.
      expect(visits).toBe(0)
    }

    const found = await server.terminalAgentTranscriptSource(id!, () => ({
      a: sleeping('session-a')
    }))
    // Another store takes over (a different status path): it never linked this id.
    const other = mkdtempSync(join(tmpdir(), 'agent-transcript-store-b-'))
    cleanups.push(() => rmSync(other, { recursive: true, force: true }))
    server.moveStatusFile(join(other, 'status.json'))
    expect(
      await server.terminalAgentTranscriptSource(id!, () => ({ a: sleeping('session-a') }), found!)
    ).toBeNull()
  }
)
