import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { nativeChatVisualsFolderFor } from '../../../native-chat/native-chat-visuals-folder'
import { ALL_RPC_METHODS } from '.'
import { STRUCTURED_AGENT_SESSION_VISUAL_METHODS } from './structured-agent-session-visual'
import {
  call as callStructured,
  clearStructuredHostStub,
  hostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

type CallClient = Parameters<typeof callStructured>[2]

function call(method: string, params: unknown, client: CallClient) {
  return callStructured(method, params, client, {}, STRUCTURED_AGENT_SESSION_VISUAL_METHODS)
}

let stateDirectory: string
vi.mock('../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => stateDirectory
}))
let record: AgentSessionRecord | null

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-visual-rpc-'))
  record = { ...agentSessionRecordFixture(), sessionId: SESSION }
  setStructuredAgentSessionHost(
    Object.assign(hostStub(), {
      deps: {
        store: { getRecord: (id: string) => (record?.sessionId === id ? record : null) }
      }
    })
  )
})

afterEach(async () => {
  clearStructuredHostStub()
  await rm(stateDirectory, { recursive: true, force: true })
})

async function writeVisual(name: string, html: string): Promise<void> {
  const folder = nativeChatVisualsFolderFor(stateDirectory, SESSION)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, name), html)
}

describe('agentSession.readVisual', () => {
  it('is registered on the runtime manifest', () => {
    expect(ALL_RPC_METHODS.map((method) => method.name)).toContain('agentSession.readVisual')
  })

  it("reads a file from the chat's own folder under the host's state directory", async () => {
    await writeVisual('chart.html', '<p>chart</p>')
    const reply = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, file: 'chart.html' },
      STRUCTURED_CLIENT
    )
    expect(reply).toMatchObject({
      ok: true,
      result: { ok: true, html: '<p>chart</p>', sizeBytes: 12 }
    })
  })

  it('answers unchanged for the revision the client holds', async () => {
    await writeVisual('chart.html', '<p>chart</p>')
    const first = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, file: 'chart.html' },
      STRUCTURED_CLIENT
    )
    const result: unknown = first.ok ? first.result : null
    const revision =
      typeof result === 'object' && result !== null && 'revision' in result
        ? String(result.revision)
        : ''
    const again = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, file: 'chart.html', knownRevision: revision },
      STRUCTURED_CLIENT
    )
    expect(again).toMatchObject({ ok: true, result: { ok: true, unchanged: true, revision } })
    const againResult: unknown = again.ok ? again.result : null
    expect(typeof againResult === 'object' && againResult !== null && 'html' in againResult).toBe(
      false
    )
  })

  it('reports a session this host has no record of', async () => {
    record = null
    const reply = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, file: 'chart.html' },
      STRUCTURED_CLIENT
    )
    expect(reply).toMatchObject({ ok: true, result: { ok: false, error: 'session_not_found' } })
  })

  it('refuses a chat recorded on another execution host or a WSL distro', async () => {
    const base = agentSessionRecordFixture()
    record = {
      ...base,
      sessionId: SESSION,
      location: { ...base.location, executionHostId: 'ssh:box' }
    }
    const ssh = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, file: 'chart.html' },
      STRUCTURED_CLIENT
    )
    expect(ssh).toMatchObject({ ok: true, result: { ok: false, error: 'unsupported_location' } })

    record = { ...base, sessionId: SESSION, location: { ...base.location, wslDistro: 'Ubuntu' } }
    const wsl = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, file: 'chart.html' },
      STRUCTURED_CLIENT
    )
    expect(wsl).toMatchObject({ ok: true, result: { ok: false, error: 'unsupported_location' } })
  })

  it.each([
    ['a path', { sessionId: SESSION, file: '../chart.html' }],
    ['a non-html file', { sessionId: SESSION, file: 'chart.txt' }],
    ['a bad session id', { sessionId: '../x', file: 'chart.html' }],
    ['an unknown field', { sessionId: SESSION, file: 'chart.html', path: '/etc' }],
    ['a malformed revision', { sessionId: SESSION, file: 'chart.html', knownRevision: 'zz' }]
  ])('rejects %s as invalid params', async (_name, params) => {
    const reply = await call('agentSession.readVisual', params, STRUCTURED_CLIENT)
    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it('is refused to a client that cannot read structured sessions', async () => {
    await writeVisual('chart.html', '<p>chart</p>')
    const reply = await call(
      'agentSession.readVisual',
      { sessionId: SESSION, file: 'chart.html' },
      { clientKind: 'runtime', clientCapabilities: [] }
    )
    expect(reply.ok).toBe(false)
  })
})
