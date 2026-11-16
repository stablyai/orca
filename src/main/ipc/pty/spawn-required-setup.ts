import { isLocalCounterPtyId } from '../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { SessionNotFoundError } from '../../daemon/protocol/daemon-errors'
import { addWslEnvKeys } from '../../../shared/shell/wsl/wsl-env'
import type { PtySpawnOperationState } from './spawn-operation-state'
import { recognizeAgentLaunchCommand } from '../../../shared/agent-launch/startup/agent-command-line-intent'
import { resolveStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveHostAgentStartupShell } from '../../../shared/shell/launch/windows-terminal-shell'
import { getRegisteredSshState } from '../../ssh/targets/ssh-target-registry'
import { isWslTerminalSpawn } from './wsl-terminal-spawn'

type SetupGatedPtyDispatch = Pick<
  PtySpawnOperationState,
  'args' | 'spawnOptions' | 'expectedWslDistro' | 'effectiveSessionAppId' | 'releaseSetupDependency'
> & {
  deps: Pick<PtySpawnOperationState['deps'], 'runtime'>
  provider: Pick<PtySpawnOperationState['provider'], 'spawn'>
}

/** Preparation keeps the real command; only the physical fresh dispatch hands it to the Setup shell. */
export async function dispatchSetupGatedPty(ctx: SetupGatedPtyDispatch, validate: () => void) {
  const { args, spawnOptions, deps } = ctx
  const wsl =
    !args.connectionId &&
    (Boolean(ctx.expectedWslDistro) ||
      isWslTerminalSpawn(spawnOptions.shellOverride, spawnOptions.cwd))
  const platform = wsl
    ? 'linux'
    : args.connectionId
      ? getRegisteredSshState(args.connectionId)?.remotePlatform
      : process.platform
  const hasAgentLaunch = Boolean(
    args.worktreeId && (spawnOptions.command || spawnOptions.launchAgent)
  )
  const tryReattach = async () => {
    if (
      !hasAgentLaunch ||
      !args.sessionId ||
      isLocalCounterPtyId(args.sessionId) ||
      spawnOptions.isNewSession ||
      args.agentSessionEnsure
    ) {
      return undefined
    }
    validate()
    try {
      const result = await ctx.provider.spawn({
        cols: spawnOptions.cols,
        rows: spawnOptions.rows,
        sessionId: args.sessionId,
        attachOnly: true,
        signal: args.signal
      })
      if (!result.isReattach) {
        throw new Error('terminal_attach_not_confirmed')
      }
      return result
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) {
        throw error
      }
      return undefined
    }
  }
  const existing = await tryReattach()
  if (existing) {
    return existing
  }
  const prepare = async () =>
    args.worktreeId && hasAgentLaunch
      ? await deps.runtime?.prepareTerminalSetupForSpawn?.({
          workspaceId: args.worktreeId,
          command: spawnOptions.command,
          agent:
            spawnOptions.launchAgent ??
            recognizeAgentLaunchCommand(args.command ?? '', { includeHeadlessOneShot: true })
              ?.agent,
          sessionId: ctx.effectiveSessionAppId,
          shell: resolveStartupShell(
            platform,
            resolveHostAgentStartupShell({
              platform,
              isRemote: Boolean(args.connectionId),
              tabShellOverride: spawnOptions.shellOverride
            })
          ),
          shellExecutable: wsl ? 'wsl.exe' : spawnOptions.shellOverride,
          signal: args.signal
        })
      : undefined
  let setup: Awaited<ReturnType<typeof prepare>>
  try {
    setup = await prepare()
  } catch (error) {
    const winner = await tryReattach()
    if (winner) {
      return winner
    }
    throw error
  }
  if (setup) {
    if (setup.command) {
      spawnOptions.command = setup.command
    }
    spawnOptions.env = { ...spawnOptions.env, ...setup.env }
    if (process.platform === 'win32' && wsl && setup.env) {
      addWslEnvKeys(spawnOptions.env, Object.keys(setup.env))
    }
    // Required carriers are internal launch data, independent of caller env deletion requests.
    spawnOptions.envToDelete = spawnOptions.envToDelete?.filter(
      (key) => !(key in (setup.env ?? {}))
    )
  }
  validate()
  const result = await ctx.provider.spawn(spawnOptions)
  if (setup && !result.isReattach && result.agentSessionEnsure?.disposition !== 'adopted') {
    ctx.releaseSetupDependency = setup.bind(result.id)
  }
  return result
}
