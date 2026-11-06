import { awaitRequiredSetup, createSetupRun } from '../setup/setup-run'
import { expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { WorktreeCreate } from '../../../shared/rpc-contract/worktree-create-params'
import {
  buildRuntimeWorktreeCreateParams,
  type WorktreeCreateRequest
} from '../../../renderer/src/store/slices/worktrees/create/worktree-create-payload'
import { buildManagedWorktreeCreateArgs } from '../rpc/methods/worktree-create-args'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock
} from '../orca-runtime-test-mocks/setup.spec'
import { createSetupRunnerScript } from '../../workspace-hooks/worktree-runner-script'
import { getEffectiveHooks, loadHooks } from '../../workspace-hooks/hooks'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import { makeRuntimeStoreWithWorkspaceSession, store } from './orca-runtime-test-fixtures.spec'

const WORKTREE_PATH = '/tmp/workspaces/native-chat-setup'
const RUNNER = '/tmp/repo/.git/orca/setup-runner.sh'
const SETUP_ENV = { ORCA_WORKTREE_PATH: WORKTREE_PATH, SETUP_INPUT: 'preserved' }

async function createFromRendererPayload(options: {
  agent?: WorktreeCreateRequest['createdWithAgent']
  mode?: 'new-tab' | 'split-horizontal' | 'split-vertical'
  activate?: boolean
  runHooks?: boolean
  withSetup?: boolean
  startup?: boolean
  promised?: true
  completeDuringSpawn?: true
  preparationFails?: true
}) {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const runtime = new OrcaRuntimeService({
    ...runtimeStore,
    getSettings: () => ({
      ...store.getSettings(),
      ...(options.mode ? { setupScriptLaunchMode: options.mode } : {})
    })
  })
  const spawn = vi.fn(
    async (args: { command?: string; env?: Record<string, string>; sessionId?: string }) => {
      const id = args.sessionId ?? `pty-native-chat-${spawn.mock.calls.length}`
      if (options.completeDuringSpawn) {
        const token = args.command?.match(/__ORCA_SETUP_COMPLETE__:([^:]+):/)?.[1]
        if (token) {
          runtime.onPtyData(id, `__ORCA_SETUP_COMPLETE__:${token}:0\n`, Date.now())
          runtime.onPtyExit(id, 0)
        }
      }
      return { id }
    }
  )
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
  vi.mocked(createSetupRunnerScript).mockResolvedValue({
    runnerScriptPath: RUNNER,
    envVars: SETUP_ENV
  })
  if (options.promised) {
    vi.mocked(loadHooks).mockReturnValue({
      scripts: { setup: 'pnpm install' },
      setupAgentStartupPolicy: 'wait-for-setup'
    })
    if (options.preparationFails) {
      vi.mocked(createSetupRunnerScript).mockRejectedValue(new Error('write failed'))
    }
  }
  const params = WorktreeCreate.parse({
    ...buildRuntimeWorktreeCreateParams(
      {
        repoId: 'repo-1',
        name: 'native-chat-setup',
        ...(options.promised ? { options: { promisedAgentChat: true } } : {}),
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
  return { result, spawn, runtime }
}

it.each([false, true])(
  "keeps the Setup run a promised chat's host launch waits for when runner preparation fails=%s",
  async (fails) => {
    const { result, spawn, runtime } = await createFromRendererPayload({
      agent: 'codex',
      promised: true,
      ...(fails ? { preparationFails: true } : {})
    })
    const run = runtime.getSetupRun(result.worktree.id)
    expect(run?.waitsForAgent).toBe(true)
    // The paired reply names that exact run, even when its runner never started: a launch waits for it.
    expect(result.agentLaunchSetup).toEqual({ required: true, runId: run?.id })
    if (fails) {
      await expect(awaitRequiredSetup(run, 'codex')).rejects.toThrow('Codex was not started')
      expect(spawn).not.toHaveBeenCalled()
    } else {
      const args = spawn.mock.calls.find(([args]) =>
        args.command?.includes('__ORCA_SETUP_COMPLETE__')
      )?.[0]
      expect(args?.sessionId).toEqual(expect.any(String))
      const token = args?.command?.match(/__ORCA_SETUP_COMPLETE__:([^:]+):/)?.[1]
      expect(token).toBeTruthy()
      runtime.onPtyData(args?.sessionId ?? '', `__ORCA_SETUP_COMPLETE__:${token}:0\n`, Date.now())
      await expect(awaitRequiredSetup(run, 'codex')).resolves.toBeUndefined()
    }
  }
)

it('retains completion emitted through runtime before the provider returns the new Setup PTY', async () => {
  const { result, runtime } = await createFromRendererPayload({
    agent: 'codex',
    promised: true,
    completeDuringSpawn: true
  })
  await expect(
    awaitRequiredSetup(runtime.getSetupRun(result.worktree.id), 'codex')
  ).resolves.toBeUndefined()
})

it('keeps a running required setup while 256 newer setups register and finish', async () => {
  const runtime = new OrcaRuntimeService(
    makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession()).runtimeStore
  )
  const slow = createSetupRun(true)
  runtime.registerSetupRun('repo::slow', slow)
  const waiting = awaitRequiredSetup(runtime.getSetupRun('repo::slow'), 'codex')
  for (let index = 0; index < 256; index += 1) {
    const later = createSetupRun(false)
    runtime.registerSetupRun(`repo::later-${index}`, later)
    later.settle({ kind: 'succeeded' })
  }
  slow.settle({ kind: 'succeeded' })
  await expect(waiting).resolves.toBeUndefined()
  expect(runtime.getSetupRun('repo::slow')).toBe(slow)
  // Settled history stays bounded: the oldest finished run gives way.
  expect(runtime.getSetupRun('repo::later-0')).toBeUndefined()
  expect(runtime.getSetupRun('repo::later-255')).toBeDefined()
})
