import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth/runtime-auth-types'
import { getDefaultSettings } from '../../../shared/constants'
import type { TuiAgent } from '../../../shared/tui-agent'

const applyAgentWorkspaceTrust = vi.hoisted(() =>
  vi.fn<(preset: string, path: string, context: unknown) => Promise<object>>(async () => ({}))
)
vi.mock('../../agent-workspace-trust', () => ({ applyAgentWorkspaceTrust }))

import { buildPtyIpcSpawnOptions } from './ipc/spawn-options'
import { createPtyIpcSpawnState, type PtyIpcSpawnState } from './ipc/spawn-state'
import type { AdoptStablePaneResult, PtySpawnIpcDeps } from './ipc/spawn-types'
import { buildRuntimePtySpawnOptions } from './runtime/spawn-options'
import { createRuntimePtySpawnState } from './runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'

type BuildInput = {
  worktreeId?: string
  cwd?: string
  connectionId?: string
  launchAgent?: TuiAgent
  command?: string
  restored?: boolean
  claudeAuth?: ClaudeRuntimeAuthPreparation | null
  wslDistro?: string | null
}

const RESTORED_PANE: AdoptStablePaneResult = {
  result: { id: 'pty-restored' },
  owner: { tabId: 'tab-1', leafId: 'leaf-1', ptyId: 'pty-restored' }
}

function notReachedByOptionBuilding(): never {
  throw new Error('spawn option building must not call this dependency')
}

function makeDeps(): PtySpawnIpcDeps & PtyRuntimeControllerDeps {
  return {
    getSettings: () => ({ ...getDefaultSettings('/tmp'), agentWorkspaceTrustEnabled: true }),
    getLocalPtyStartupPromise: notReachedByOptionBuilding,
    getLocalPtyProviderStartupPromise: notReachedByOptionBuilding,
    adoptStablePane: notReachedByOptionBuilding,
    assertFolderWorkspacePtyPathUsable: notReachedByOptionBuilding,
    resolvePtySpawnStartupCwd: notReachedByOptionBuilding,
    localStartupCwdDirectoryExists: notReachedByOptionBuilding,
    prepareCodexResumeHome: notReachedByOptionBuilding,
    noCodexResumeLaunch: notReachedByOptionBuilding,
    resolveCodexResumeLaunch: notReachedByOptionBuilding,
    reconcileSharedRuntimeResumeHome: notReachedByOptionBuilding,
    stripSequencedStartupResumeArgv: notReachedByOptionBuilding,
    transitionSpawnHiddenRendererPtyDeliveryState: notReachedByOptionBuilding,
    trustedTerminalHandleEnv: new Set(),
    sendPtySpawnedToRenderer: notReachedByOptionBuilding,
    syncPtyBackgroundedDelivery: notReachedByOptionBuilding,
    stopReplacedPty: notReachedByOptionBuilding,
    requestSerializedBuffer: notReachedByOptionBuilding,
    shutdownProviderAndDetectExit: notReachedByOptionBuilding,
    rememberSyntheticKillExit: notReachedByOptionBuilding,
    rememberRetiredRejectedPty: notReachedByOptionBuilding,
    sendPtyExitToRenderer: notReachedByOptionBuilding,
    finishPtyShutdown: notReachedByOptionBuilding,
    retiredRejectedPtyIds: new Map()
  }
}

/** What preflight and env assembly leave for the option builders; both spawn states share it. */
function seed(
  ctx: Pick<
    PtyIpcSpawnState,
    'env' | 'cwd' | 'launchCommand' | 'claudeAuth' | 'expectedWslDistro' | 'preAdoptedStablePane'
  >,
  input: BuildInput
): void {
  ctx.env = { CLAUDE_CONFIG_DIR: '/cfg' }
  ctx.cwd = input.cwd
  ctx.launchCommand = input.command
  ctx.claudeAuth = input.claudeAuth ?? null
  ctx.expectedWslDistro = input.wslDistro ?? null
  ctx.preAdoptedStablePane = input.restored ? RESTORED_PANE : null
}

async function build(route: 'renderer' | 'runtime', input: BuildInput) {
  const args = {
    cols: 80,
    rows: 24,
    worktreeId: input.worktreeId ?? 'repo-1::/repo/wt',
    connectionId: input.connectionId,
    launchAgent: input.launchAgent,
    command: input.command
  }
  if (route === 'renderer') {
    const ctx = createPtyIpcSpawnState(makeDeps(), args)
    seed(ctx, input)
    await buildPtyIpcSpawnOptions(ctx)
    ctx.finishTerminalInstall()
    return ctx.spawnOptions
  }
  const ctx = createRuntimePtySpawnState(makeDeps(), args)
  seed(ctx, input)
  await buildRuntimePtySpawnOptions(ctx)
  ctx.finishTerminalInstall()
  return ctx.spawnOptions
}

beforeEach(() => {
  applyAgentWorkspaceTrust.mockReset()
  applyAgentWorkspaceTrust.mockResolvedValue({})
})

describe.each(['renderer', 'runtime'] as const)('%s spawn builder agent trust', (route) => {
  it('pre-trusts the workspace for a fresh agent launch with the final spawn context', async () => {
    await build(route, {
      launchAgent: 'codex',
      command: 'codex',
      wslDistro: 'Ubuntu'
    })
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith('codex', '/repo/wt', {
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/cfg' }),
      claudeAuth: null,
      wslDistro: 'Ubuntu',
      connectionId: null
    })
  })

  it('trusts Codex in a floating terminal at the resolved folder it starts in', async () => {
    await build(route, {
      worktreeId: 'global-floating-terminal',
      cwd: '/Users/me',
      launchAgent: 'codex',
      command: 'codex'
    })
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith('codex', '/Users/me', expect.anything())
  })

  it('holds the spawn until the trust write settles', async () => {
    let settleTrust = (): void => {}
    applyAgentWorkspaceTrust.mockReturnValueOnce(
      new Promise((resolve) => {
        settleTrust = () => resolve({})
      })
    )
    let built = false
    const building = build(route, { launchAgent: 'claude', command: 'claude' }).then(() => {
      built = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(built).toBe(false)
    settleTrust()
    await building
    expect(built).toBe(true)
  })

  it('keys on the declared agent even when setup sequencing rewrote the command', async () => {
    await build(route, { launchAgent: 'claude', command: 'sh /tmp/orca-setup-runner.sh' })
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith('claude', '/repo/wt', expect.anything())
  })

  it('never re-runs trust for a restored pane or a spawn with no launch command', async () => {
    await build(route, { launchAgent: 'claude', command: 'claude', restored: true })
    await build(route, { launchAgent: 'claude' })
    expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
  })

  it('forwards the relay trust field on an SSH agent spawn', async () => {
    applyAgentWorkspaceTrust.mockResolvedValueOnce({
      agentWorkspaceTrust: { workspacePath: '/repo/wt' }
    })
    const options = await build(route, {
      connectionId: 'ssh-1',
      launchAgent: 'codex',
      command: 'codex'
    })
    expect(options.agentWorkspaceTrust).toEqual({ workspacePath: '/repo/wt' })
  })
})
