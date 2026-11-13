import { closeTestJournalHostDatabases } from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FolderWorkspaceCreateRefusedError } from '../../../../project-groups/folder-workspace-create-refusal'
import type { AgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store-test-harness'
import type { RpcContext } from '../../core'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const createStructuredSession = vi.fn(async (_args: Record<string, unknown>) => ({
  ok: true as const,
  value: { sessionId: 'sess-1' }
}))

vi.mock('../structured-sessions/creation/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (args: Record<string, unknown>) =>
    createStructuredSession(args)
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const FOLDER_LAUNCH = {
  agent: 'claude',
  target: {
    kind: 'create-folder-workspace',
    create: { projectGroupId: 'group-1', name: 'notes', createdWithAgent: 'codex' }
  }
}
// A desktop client of a remote server: paired, but not a phone, so it may create folder workspaces.
const PAIRED_DESKTOP: Partial<RpcContext> = { ...CAPABLE_CLIENT, clientKind: 'runtime' }

function folderRuntime(options: Parameters<typeof runtimeStub>[0] = {}) {
  return Object.assign(runtimeStub(options), {
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
}

beforeEach(() => {
  createStructuredSession.mockClear()
})

describe('a replayed folder launch', () => {
  // The ledger admits against `Date.now()`, so the id must be dated now.
  const OPERATION_ID = `${Date.now()}-000000000000000000000000000000ff`
  const PATH_UNAVAILABLE = 'folder_workspace_path_unavailable:/srv/notes'
  let directory: string
  let store: AgentSessionRecordStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-folder-'))
    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
  })

  afterEach(async () => {
    setAgentLaunchRecordStore(null)
    await closeTestJournalHostDatabases()
    await rm(directory, { recursive: true, force: true })
  })

  function replay(runtime: AgentLaunchRuntimeStub) {
    const params = AGENT_LAUNCH_REPLAY.params.parse({ ...FOLDER_LAUNCH, operationId: OPERATION_ID })
    return AGENT_LAUNCH_REPLAY.handler(params, rpcContext(runtime, PAIRED_DESKTOP))
  }

  function outcome() {
    return store.listOperationRows().find((row) => row.operationId === OPERATION_ID)?.outcome
  }

  it('answers a retry from the record without creating a second workspace', async () => {
    await replay(folderRuntime({ settings: {} }))

    const retry = folderRuntime({ settings: {} })
    const result = await replay(retry)

    expect(retry.createFolderWorkspace).not.toHaveBeenCalled()
    expect(retry.createTerminal).not.toHaveBeenCalled()
    expect(result).toMatchObject({ worktreeId: 'folder:fw-new', outcome: { kind: 'terminal' } })
  })

  it('does not duplicate a terminal when the requested startup fails', async () => {
    const runtime = folderRuntime()
    const original = runtime.createFolderWorkspace.getMockImplementation()!
    runtime.createFolderWorkspace.mockImplementationOnce(async (input) => ({
      ...(await original(input)),
      startupTerminal: undefined
    }))
    await expect(replay(runtime)).rejects.toThrow()
    expect(runtime.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(createStructuredSession).not.toHaveBeenCalled()
  })

  it('records a create refused before anything was stored as failed, and replays that', async () => {
    const first = folderRuntime({ settings: {} })
    first.createFolderWorkspace.mockRejectedValueOnce(
      new FolderWorkspaceCreateRefusedError(PATH_UNAVAILABLE)
    )

    await expect(replay(first)).rejects.toThrow(PATH_UNAVAILABLE)
    expect(outcome()).toMatchObject({ status: 'failed', code: PATH_UNAVAILABLE })

    const retry = folderRuntime({ settings: {} })
    await expect(replay(retry)).rejects.toThrow(PATH_UNAVAILABLE)
    expect(retry.createFolderWorkspace).not.toHaveBeenCalled()
  })

  it('stays unknown when the failure came after the workspace was created', async () => {
    const first = folderRuntime({ settings: {} })
    // Only a typed create refusal proves no effects; identical untyped error text does not.
    first.showTerminalWorkspaceLaunchScope.mockRejectedValueOnce(new Error(PATH_UNAVAILABLE))

    await expect(replay(first)).rejects.toThrow('agent_session_operation_unknown')
    expect(first.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(outcome()?.status).not.toBe('failed')

    const retry = folderRuntime({ settings: {} })
    await expect(replay(retry)).rejects.toThrow('agent_session_operation_unknown')
    expect(retry.createFolderWorkspace).not.toHaveBeenCalled()
  })
})
