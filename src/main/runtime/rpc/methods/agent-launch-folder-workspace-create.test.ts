/**
 * `agent.launch` with a `create-folder-workspace` target: the host creates the folder workspace,
 * then starts the agent in it exactly as it would in a folder workspace that already existed.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_TARGET_FORBIDDEN_CODE } from '../../../../shared/agent-launch-target-forbidden'
import { FolderWorkspaceCreateRefusedError } from '../../../project-groups/folder-workspace-create-refusal'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { RpcContext } from '../core'
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

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (args: Record<string, unknown>) =>
    createStructuredSession(args)
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
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

function launch(
  params: unknown,
  runtime: AgentLaunchRuntimeStub,
  context: Partial<RpcContext> = PAIRED_DESKTOP
) {
  return AGENT_LAUNCH.handler(AGENT_LAUNCH.params.parse(params), rpcContext(runtime, context))
}

beforeEach(() => {
  createStructuredSession.mockClear()
})

describe('agent.launch creating a folder workspace', () => {
  it('creates the workspace, then starts a terminal agent in it', async () => {
    const runtime = folderRuntime({ settings: {} })

    const result = await launch(FOLDER_LAUNCH, runtime)

    expect(runtime.createFolderWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectGroupId: 'group-1',
        name: 'notes',
        // The launch's agent, not the one the create payload named.
        createdWithAgent: 'claude',
        creatorProvenance: { kind: 'paired-device', deviceId: 'device-1' }
      })
    )
    expect(runtime.showTerminalWorkspaceLaunchScope).toHaveBeenCalledWith('id:folder:fw-new')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    // A paired caller's terminal is not surfaced on the host window.
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:folder:fw-new',
      expect.objectContaining({ surfaceOwner: false })
    )
    expect(result).toMatchObject({
      worktreeId: 'folder:fw-new',
      outcome: { kind: 'terminal', handle: 'term_1' }
    })
  })

  it('opens a structured chat in the new workspace when that is the default', async () => {
    const runtime = folderRuntime()

    const result = await launch(FOLDER_LAUNCH, runtime)

    expect(createStructuredSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: 'id:folder:fw-new' })
    )
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(result).toMatchObject({ worktreeId: 'folder:fw-new', outcome: { kind: 'structured' } })
  })

  it.each([
    ['an SSH', 'ssh-1'],
    ['a local', null]
  ] as const)(
    'keeps %s folder workspace connection through to the agent it starts',
    async (_where, connectionId) => {
      const runtime = folderRuntime({ createSupport: { supported: false, reason: 'remote' } })
      runtime.showTerminalWorkspaceLaunchScope.mockImplementationOnce(async (selector: string) => ({
        id: selector.replace(/^id:/, ''),
        path: '/srv/notes',
        connectionId,
        repo: null,
        folderWorkspace: null
      }))
      const create = { ...FOLDER_LAUNCH.target.create, connectionId }

      await launch(
        { ...FOLDER_LAUNCH, agent: 'opencode', target: { ...FOLDER_LAUNCH.target, create } },
        runtime
      )

      expect(runtime.createFolderWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId })
      )
      expect(runtime.createTerminal).toHaveBeenCalledWith('id:folder:fw-new', expect.anything())
    }
  )

  it('rejects a folder create with no project group, the same as folderWorkspace.create', () => {
    const parsed = AGENT_LAUNCH.params.safeParse({
      agent: 'claude',
      target: { kind: 'create-folder-workspace', create: { name: 'notes' } }
    })
    expect(parsed.success).toBe(false)
  })
})

describe('a phone asking for a folder workspace', () => {
  // `folderWorkspace.create` is not on the mobile allowlist, so the launch may not do it either.
  const PHONE_LAUNCH = {
    ...FOLDER_LAUNCH,
    operationId: `${Date.now()}-000000000000000000000000000000ee`
  }

  it.each([
    [
      'agent.launch',
      (runtime: AgentLaunchRuntimeStub) => launch(PHONE_LAUNCH, runtime, CAPABLE_CLIENT)
    ],
    [
      'agent.launchReplay',
      (runtime: AgentLaunchRuntimeStub) =>
        AGENT_LAUNCH_REPLAY.handler(
          AGENT_LAUNCH_REPLAY.params.parse(PHONE_LAUNCH),
          rpcContext(runtime, CAPABLE_CLIENT)
        )
    ]
  ])('%s refuses it before admitting or creating anything', async (_method, send) => {
    const runtime = folderRuntime()

    await expect(send(runtime)).rejects.toThrow(AGENT_LAUNCH_TARGET_FORBIDDEN_CODE)
    expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
    expect(runtime.createFolderWorkspace).not.toHaveBeenCalled()
  })
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

  // The path is shown to the user, so a replay names the whole folder or none of it.
  it.each([
    ['repeats a long path in full', `/srv/${'nested/'.repeat(30)}notes`, true],
    ['drops a path no filesystem accepts', `/srv/${'n'.repeat(5000)}`, false]
  ])('%s when it replays a refused create', async (_case, path, keepsPath) => {
    const refusal = `folder_workspace_path_missing:${path}`
    const first = folderRuntime({ settings: {} })
    first.createFolderWorkspace.mockRejectedValueOnce(
      new FolderWorkspaceCreateRefusedError(refusal)
    )
    await expect(replay(first)).rejects.toMatchObject({ message: refusal })

    const replayed = keepsPath ? refusal : 'folder_workspace_path_missing'
    await expect(replay(folderRuntime({ settings: {} }))).rejects.toMatchObject({
      message: replayed
    })
  })

  it('stays unknown when the failure came after the workspace was created', async () => {
    const first = folderRuntime({ settings: {} })
    // The same words as a refused create, but untyped: only the create's own refusal proves nothing.
    first.showTerminalWorkspaceLaunchScope.mockRejectedValueOnce(new Error(PATH_UNAVAILABLE))

    await expect(replay(first)).rejects.toThrow('agent_session_operation_unknown')
    expect(first.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(outcome()?.status).not.toBe('failed')

    const retry = folderRuntime({ settings: {} })
    await expect(replay(retry)).rejects.toThrow('agent_session_operation_unknown')
    expect(retry.createFolderWorkspace).not.toHaveBeenCalled()
  })
})
