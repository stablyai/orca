import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import '../unused-default-rpc-methods.test-fixture'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { nativeChatScratchFolderFor } from '../../../native-chat/native-chat-scratch-folder'
import { nativeChatVisualRevision } from '../../../native-chat/native-chat-visual-file-read'
import { Store } from '../../../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore
} from '../../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { FILE_METHODS } from './files'
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
  record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: SESSION }))
  setStructuredAgentSessionHost(
    Object.assign(hostStub(), {
      deps: {
        store: {
          getConversation: (id: string) =>
            record?.sessionId === id ? agentSessionConversationView(record) : null
        }
      }
    })
  )
})

afterEach(async () => {
  clearStructuredHostStub()
  await closeTestStores()
  await rm(stateDirectory, { recursive: true, force: true, maxRetries: 3 })
})

async function writeVisual(name: string, html: string): Promise<void> {
  const folder = nativeChatScratchFolderFor(stateDirectory, SESSION)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, name), html)
}

describe('agentSession.readVisual', () => {
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

  it('serves the folder a visual names as a file root, and nothing outside it', async () => {
    await writeVisual('chart.html', 'a')
    const folder = nativeChatScratchFolderFor(stateDirectory, SESSION)
    // Same suffix but inside the authorized root, so only the selector's exact match refuses it.
    const foreign = nativeChatScratchFolderFor(join(folder, 'nested'), SESSION)
    await Promise.all([mkdir(foreign, { recursive: true }), mkdir(join(stateDirectory, 'out'))])
    await writeFile(join(foreign, 'x.html'), 'x')
    await writeFile(join(stateDirectory, 'out', 'x.html'), 'x')
    await symlink(join(stateDirectory, 'out'), join(folder, 'out'), 'junction')
    const path = join(folder, 'chart.html')
    const visual = { sessionId: SESSION, file: 'chart.html' }
    const readVisual = (params: { knownRevision?: string }) =>
      call('agentSession.readVisual', { ...visual, ...params }, STRUCTURED_CLIENT)
    expect(await readVisual({})).toMatchObject({ result: { html: 'a', path } })
    const knownRevision = nativeChatVisualRevision(Buffer.from('a'))
    expect(await readVisual({ knownRevision })).toMatchObject({ result: { unchanged: true, path } })
    const dataFile = join(stateDirectory, 'db', 'data.json')
    const runtime = new OrcaRuntimeService(createSqliteTestStore(Store, { dataFile }))
    const files = (method: string, worktree: string, relativePath: string, extra = {}) =>
      new RpcDispatcher({ runtime, methods: FILE_METHODS }).dispatch({
        id: 'r',
        authToken: 't',
        method,
        params: { worktree, relativePath, ...extra }
      })
    const root = `path:${folder}`
    const write = { content: 'b', expectedExecutionHostId: 'local' }
    expect(await files('files.write', root, 'chart.html', write)).toMatchObject({ ok: true })
    const read = await files('files.read', root, 'chart.html')
    expect(read).toMatchObject({ result: { content: 'b' } })
    const preview = { entryRelativePath: 'chart.html', implicitRootRelativePath: null }
    const docPreview = { ...preview, authorizedRootRelativePaths: [] }
    const previewed = await files('files.readDocPreview', root, 'chart.html', docPreview)
    expect(previewed).toMatchObject({ result: { content: 'b' } })
    const refusal = { error: { message: 'chat_scratch_not_openable' } }
    expect(await files('files.open', root, 'chart.html')).toMatchObject(refusal)
    expect(await files('files.read', `path:${foreign}`, 'x.html')).toMatchObject({ ok: false })
    expect(await files('files.read', root, 'out/x.html')).toMatchObject({ ok: false })
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
