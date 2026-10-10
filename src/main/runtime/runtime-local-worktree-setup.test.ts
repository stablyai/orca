import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { getDefaultRepoHookSettings } from '../../shared/constants'

const mocks = vi.hoisted(() => ({
  effectiveHooks: vi.fn(),
  runHook: vi.fn()
}))

vi.mock('../hooks', () => ({
  getEffectiveHooks: mocks.effectiveHooks,
  loadHooks: () => null,
  runHook: mocks.runHook
}))

import {
  buildRuntimeLocalWorktreeSetupReceipt,
  prepareRuntimeLocalWorktreeSetup
} from './runtime-local-worktree-setup'

const askRepo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000000',
  addedAt: 0,
  hookSettings: { ...getDefaultRepoHookSettings(), setupRunPolicy: 'ask' }
}

function prepare(request: { setupDecision?: 'run' | 'skip' | 'inherit' } = {}) {
  return prepareRuntimeLocalWorktreeSetup({
    request: { repoSelector: 'repo-1', name: 'app', ...request },
    repo: askRepo,
    worktreePath: '/worktrees/app',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings are read only by the setup runner, which this in-process path never builds.
    settings: {} as never,
    runtimeTarget: undefined,
    shouldUseSetupRunner: false
  })
}

describe('runtime create setup for a hook the new branch added', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.runHook.mockResolvedValue({ success: true, output: '' })
    mocks.effectiveHooks.mockReturnValue({ scripts: { setup: 'pnpm install' } })
  })

  it('skips setup with a warning instead of failing a create that already added the worktree', async () => {
    const result = await prepare()

    expect(result.shouldRunSetup).toBe(false)
    expect(result.warning).toContain('pass --setup run to run it')
    expect(mocks.runHook).not.toHaveBeenCalled()
    expect(
      buildRuntimeLocalWorktreeSetupReceipt({
        ...result,
        didSpawnSetup: false,
        setupTerminalHandle: null
      })
    ).toEqual({
      requested: 'inherit',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'skipped'
    })
  })

  it('still runs setup when the caller decided to', async () => {
    const result = await prepare({ setupDecision: 'run' })

    expect(result.shouldRunSetup).toBe(true)
    expect(mocks.runHook).toHaveBeenCalledOnce()
    expect(
      buildRuntimeLocalWorktreeSetupReceipt({
        ...result,
        didSpawnSetup: false,
        setupTerminalHandle: null
      })
    ).toEqual({
      requested: 'run',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'running'
    })
  })

  it('reports an absent hook without requiring a terminal', async () => {
    mocks.effectiveHooks.mockReturnValue(null)
    const result = await prepare({ setupDecision: 'run' })

    expect(
      buildRuntimeLocalWorktreeSetupReceipt({
        ...result,
        didSpawnSetup: false,
        setupTerminalHandle: null
      })
    ).toEqual({
      requested: 'run',
      hookFound: false,
      startupPolicy: 'start-immediately',
      state: 'not_configured'
    })
  })

  it('reports a failed runner spawn when no in-process hook is running', () => {
    expect(
      buildRuntimeLocalWorktreeSetupReceipt({
        effectiveDecision: 'run',
        hookFound: true,
        shouldRunSetup: true,
        didSpawnSetup: false,
        didStartInProcessSetupHook: false,
        setupTerminalHandle: null
      })
    ).toEqual({
      requested: 'run',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'spawn_failed'
    })
  })

  it('reports the spawned setup terminal and its agent wait policy', () => {
    expect(
      buildRuntimeLocalWorktreeSetupReceipt({
        effectiveDecision: 'run',
        hookFound: true,
        setup: {
          command: 'setup-runner',
          runnerScriptPath: '/worktrees/app/setup.sh',
          envVars: {},
          waitForAgentStartup: true
        },
        shouldRunSetup: true,
        didSpawnSetup: true,
        didStartInProcessSetupHook: false,
        setupTerminalHandle: 'setup-terminal'
      })
    ).toEqual({
      requested: 'run',
      hookFound: true,
      startupPolicy: 'wait-for-setup',
      state: 'running',
      terminalHandle: 'setup-terminal'
    })
  })
})
