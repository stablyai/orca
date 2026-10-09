import { prepareAntigravityAccountForLaunch } from '../../antigravity/native-account-launch'
import {
  createAntigravityAccountOperation,
  remainingAccountOperationMs,
  withAntigravityAccountOperation
} from '../../antigravity/native-account-operation'
import { resolveWslSessionContext } from '../../daemon/wsl-session-context'
import { LocalPtyProvider } from '../../providers/local-pty-provider'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../providers/types'
import { SessionNotFoundError } from '../../daemon/daemon-errors'
import { recognizeAgentProcessFromCommandLine } from '../../../shared/agent-process-recognition'
import { routesFreshSpawnsToLocalProvider } from './host-env/fresh-spawn-routing'
import { isWslShellName } from '../../../shared/local-windows-terminal-runtime'
import type { CodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'

export async function prepareAntigravityPtySpawnTarget(
  ctx: {
    provider: IPtyProvider
    spawnOptions: PtySpawnOptions
    preAdoptedStablePane: unknown
    expectedWslDistro: string | null
    terminalRuntimeOptions: { terminalWindowsWslDistro?: string | null }
    codexSelectionTarget: CodexAccountSelectionTarget
  },
  connectionId?: string | null
): Promise<PtySpawnResult | void> {
  if (
    connectionId ||
    ctx.preAdoptedStablePane ||
    ctx.spawnOptions.attachOnly ||
    ctx.provider instanceof LocalPtyProvider ||
    routesFreshSpawnsToLocalProvider(ctx.provider)
  ) {
    return
  }
  const options = ctx.spawnOptions
  const agent =
    options.launchAgent ??
    (options.command ? recognizeAgentProcessFromCommandLine(options.command)?.agent : null)
  if (agent !== 'antigravity') {
    return
  }
  const parent =
    options.antigravityAccountOperation ?? createAntigravityAccountOperation(options.signal)
  return withAntigravityAccountOperation(async (operation): Promise<PtySpawnResult | void> => {
    options.antigravityAccountOperation = operation
    if (
      options.sessionId &&
      !options.isNewSession &&
      !options.agentSessionEnsure &&
      !options.agentSessionCreateOperationId
    ) {
      try {
        const attached = await ctx.provider.spawn({
          ...options,
          attachOnly: true,
          signal: operation.signal
        })
        remainingAccountOperationMs(operation)
        if (attached.id !== options.sessionId || attached.isReattach !== true) {
          throw new Error('Terminal session owner could not be verified')
        }
        return attached
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) {
          throw error
        }
      }
    }
    const wsl = resolveWslSessionContext(options)
    const isWsl =
      wsl !== undefined || (process.platform === 'win32' && isWslShellName(options.shellOverride))
    const prepared = await prepareAntigravityAccountForLaunch({
      launchAgent: options.launchAgent,
      command: options.command,
      isWsl,
      wslDistro: wsl?.distro,
      env: options.env,
      envToDelete: options.envToDelete,
      operation
    })
    if (!prepared) {
      return
    }
    if (!isWsl || (wsl && wsl.distro.toLowerCase() !== prepared.wslDistro.toLowerCase())) {
      throw new Error('The prepared WSL account does not match the terminal execution target')
    }
    options.terminalWindowsWslDistro = prepared.wslDistro
    ctx.expectedWslDistro = prepared.wslDistro
    ctx.terminalRuntimeOptions.terminalWindowsWslDistro = prepared.wslDistro
    ctx.codexSelectionTarget = { runtime: 'wsl', wslDistro: prepared.wslDistro }
  }, parent)
}
