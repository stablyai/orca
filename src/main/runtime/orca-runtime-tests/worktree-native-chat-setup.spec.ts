import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { WorktreeCreate } from '../../../shared/rpc-contract/worktree-create-params'
import {
  buildRuntimeWorktreeCreateParams,
  type WorktreeCreateRequest
} from '../../../renderer/src/store/slices/worktrees/create/worktree-create-payload'
import { buildManagedWorktreeCreateArgs } from '../rpc/methods/worktree-create-args'
import {
  OrcaRuntimeService,
  computeWorktreePathMock,
  createSetupRunnerScript,
  ensurePathWithinWorkspaceMock,
  getDefaultTabsLaunch,
  getEffectiveHooks,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import {
  makeRuntimeStoreWithWorkspaceSession,
  spawnedPtyEnv,
  store
} from '../orca-runtime-test-fixtures.spec'

const WORKTREE_PATH = '/tmp/workspaces/native-chat-setup'
const RUNNER = '/tmp/repo/.git/orca/setup-runner.sh'
const SETUP_ENV = { ORCA_WORKTREE_PATH: WORKTREE_PATH, SETUP_INPUT: 'preserved' }

async function createFromRendererPayload(options: {
  agent?: WorktreeCreateRequest['createdWithAgent']
  mode?: 'new-tab' | 'split-horizontal' | 'split-vertical'
  activate?: boolean
  runHooks?: boolean
  withSetup?: boolean
  defaultTabs?: boolean
  startup?: boolean
}) {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const runtime = new OrcaRuntimeService({
    ...runtimeStore,
    getSettings: () => ({
      ...store.getSettings(),
      ...(options.mode ? { setupScriptLaunchMode: options.mode } : {})
    })
  })
  const spawn = vi.fn(async (_args: { command?: string; env?: Record<string, string> }) => ({
    id: `pty-native-chat-${spawn.mock.calls.length}`
  }))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  computeWorktreePathMock.mockReturnValue(WORKTREE_PATH)
  ensurePathWithinWorkspaceMock.mockReturnValue(WORKTREE_PATH)
  vi.mocked(listWorktrees).mockResolvedValue([
    {
      path: WORKTREE_PATH,
      head: 'def',
      branch: 'native-chat-setup',
      isBare: false,
      isMainWorktree: false
    }
  ])
  vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm install' } })
  vi.mocked(createSetupRunnerScript).mockReturnValue({
    runnerScriptPath: RUNNER,
    envVars: SETUP_ENV
  })
  if (options.defaultTabs) {
    vi.mocked(getDefaultTabsLaunch).mockReturnValue({
      runCommands: true,
      tabs: [{ title: 'Dev', command: 'pnpm dev' }]
    })
  }
  const params = WorktreeCreate.parse({
    ...buildRuntimeWorktreeCreateParams(
      {
        repoId: 'repo-1',
        name: 'native-chat-setup',
        setupDecision: options.withSetup === false ? 'skip' : 'run',
        ...(options.agent ? { createdWithAgent: options.agent } : {}),
        ...(options.startup ? { startup: { command: 'codex' } } : {})
      },
      { name: 'native-chat-setup' }
    ),
    ...(options.activate ? { activate: true } : {}),
    ...(options.runHooks ? { runHooks: true } : {})
  })
  const args = buildManagedWorktreeCreateArgs(params, {}, { clientKind: 'runtime' })
  expect(args.createdWithAgent).toBe(options.agent)
  expect(args.startup?.command).toBe(options.startup ? 'codex' : undefined)
  expect(args.activate).toBe(options.activate === true || options.startup === true)
  expect(args.runHooks).toBe(options.runHooks === true)
  const result = await runtime.createManagedWorktree({ ...args, awaitTerminalProvisioning: true })
  return { result, spawn }
}

describe('native-chat setup through renderer payload, RPC and execution host', () => {
  it.each(
    (['claude', 'codex'] as const).flatMap((agent) =>
      (['new-tab', 'split-horizontal', 'split-vertical', undefined] as const).map((mode) => ({
        agent,
        mode
      }))
    )
  )(
    'creates only Setup for a background $agent chat with retired location $mode',
    async ({ agent, mode }) => {
      const { result, spawn } = await createFromRendererPayload({ agent, mode })
      expect(spawn.mock.calls.map(([args]) => args.command)).toEqual([`bash ${RUNNER}`])
      expect(spawn.mock.calls[0][0].env).toMatchObject(SETUP_ENV)
      expect(result.setup).toBeUndefined()
      expect(result.setupReceipt).toMatchObject({ state: 'running' })
      expect(result.startupTerminal).toBeUndefined()
    }
  )

  it.each([false, true])('keeps existing no-setup background policy (agent=%s)', async (agent) => {
    const { spawn } = await createFromRendererPayload({
      ...(agent ? { agent: 'codex' } : {}),
      withSetup: false
    })
    expect(spawn.mock.calls.map(([args]) => args.command)).toEqual(agent ? [] : [undefined])
  })

  it.each([
    { label: 'blank selection' },
    { label: 'activated attribution', agent: 'codex' as const, activate: true },
    { label: 'run-hooks attribution', agent: 'codex' as const, runHooks: true }
  ])('keeps a primary shell for $label', async (options) => {
    const { spawn } = await createFromRendererPayload(options)
    expect(spawn.mock.calls.map(([args]) => args.command)).toEqual([undefined, `bash ${RUNNER}`])
  })

  it.each(['split-horizontal', 'split-vertical'] as const)(
    'gives the requested startup and Setup separate tabs despite retired location %s',
    async (mode) => {
      const { spawn } = await createFromRendererPayload({ agent: 'codex', mode, startup: true })
      expect(spawn.mock.calls.map(([args]) => args.command)).toEqual(['codex', `bash ${RUNNER}`])
      const startupTabId = spawnedPtyEnv(spawn.mock.calls[0][0]).ORCA_TAB_ID
      expect(startupTabId).toEqual(expect.any(String))
      expect(startupTabId).not.toBe('')
      expect(startupTabId).not.toBe(spawnedPtyEnv(spawn.mock.calls[1][0]).ORCA_TAB_ID)
    }
  )

  it('keeps configured default commands alongside Setup', async () => {
    const { spawn } = await createFromRendererPayload({ agent: 'codex', defaultTabs: true })
    expect(spawn.mock.calls.map(([args]) => args.command)).toEqual(['pnpm dev', `bash ${RUNNER}`])
  })

  it('keeps the actual startup terminal alongside Setup', async () => {
    const { result, spawn } = await createFromRendererPayload({ agent: 'codex', startup: true })
    expect(spawn.mock.calls.map(([args]) => args.command)).toEqual(['codex', `bash ${RUNNER}`])
    expect(result.startupTerminal).toMatchObject({ spawned: true })
  })
})
