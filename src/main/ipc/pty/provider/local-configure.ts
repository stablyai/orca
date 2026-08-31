import { getAppEnvironment } from '../../../../shared/app-environment'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isAgentStatusHooksEnabled } from '../../../agent-hooks/managed-agent-hook-controls'
import { isPwshAvailableAsync } from '../../../pwsh'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import {
  addOrcaWslInteropEnv,
  stampWslOrchestrationCompatibilityHost
} from '../../../pty/wsl-orca-env'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import { markClaudePtyExited } from '../../../claude-accounts/live-pty-gate'
import { buildPtyHostEnv } from '../host-env/assembly'
import {
  getCompatibleSelectedCodexHomePath,
  isCodexStatusHooksEnabled,
  shouldStripInheritedOrcaCodexHome
} from '../host-env/codex-home'
import type { GetSelectedCodexHomePath } from '../host-env/types'
import { isCurrentPtyExit, ptyOwnership } from './ownership-state'
import { localProvider } from './registry'
import { clearProviderPtyState } from './state-cleanup'

export function configureLocalPtyProvider(args: {
  runtime?: OrcaRuntimeService
  getSettings?: () => GlobalSettings
  getSelectedCodexHomePath?: GetSelectedCodexHomePath
  trustedTerminalHandleEnv: Set<string>
}): void {
  // Why: only LocalPtyProvider needs main-process hook injection; daemon-backed providers spawn subprocesses internally.
  if (!(localProvider instanceof LocalPtyProvider)) {
    return
  }
  const { runtime, getSettings, getSelectedCodexHomePath, trustedTerminalHandleEnv } = args
  localProvider.configure({
    isHistoryEnabled: () => getSettings?.()?.terminalScopeHistoryByWorktree ?? true,
    getWindowsShell: () => getSettings?.()?.terminalWindowsShell,
    getWindowsPowerShellImplementation: () =>
      getSettings ? (getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto') : undefined,
    pwshAvailable: () => isPwshAvailableAsync(),
    buildSpawnEnv: async (id, baseEnv, ctx) => {
      const codexSelectionTarget: CodexAccountSelectionTarget =
        ctx?.isWsl === true
          ? { runtime: 'wsl', wslDistro: ctx.wslDistro ?? null }
          : { runtime: 'host' }
      const selectedCodexHomePath = getCompatibleSelectedCodexHomePath(
        codexSelectionTarget,
        ctx?.codexHomePathOverride
          ? ctx.codexHomePathOverride.value
          : ((await getSelectedCodexHomePath?.(codexSelectionTarget, baseEnv, {
              workspacePath: ctx?.cwd,
              launchAgent: ctx?.launchAgent
            })) ?? null)
      )
      const skipCodexHomeEnv = ctx?.isWsl === true && !selectedCodexHomePath
      const ptySettings = getSettings?.()
      const env = buildPtyHostEnv(id, baseEnv, {
        isPackaged: getAppEnvironment().isPackaged(),
        resourcesPath: process.resourcesPath,
        userDataPath: getAppEnvironment().getPath('userData'),
        selectedCodexHomePath,
        skipCodexHomeEnv,
        stripInheritedOrcaCodexHome: shouldStripInheritedOrcaCodexHome({
          target: codexSelectionTarget,
          selectedCodexHomePath,
          skipCodexHomeEnv,
          settings: ptySettings
        }),
        launchCommand: ctx?.command,
        launchAgent: ctx?.launchAgent,
        isWsl: ctx?.isWsl,
        wslDistro: ctx?.wslDistro ?? null,
        agentStatusHooksEnabled: isAgentStatusHooksEnabled(ptySettings),
        codexStatusHooksEnabled: isCodexStatusHooksEnabled(ptySettings),
        networkProxySettings: ptySettings,
        routeBrowserOpensToClient: runtime?.shouldRelayTerminalBrowserOpens?.()
      })
      // Why: agents need their terminal handle at process start to self-identify in orchestration messages without an extra RPC.
      const requestedHandle = baseEnv.ORCA_TERMINAL_HANDLE
      const preAllocatedHandle =
        requestedHandle && trustedTerminalHandleEnv.has(requestedHandle)
          ? requestedHandle
          : runtime?.preAllocateHandleForPty(id)
      if (requestedHandle && requestedHandle !== preAllocatedHandle) {
        delete env.ORCA_TERMINAL_HANDLE
      }
      if (preAllocatedHandle) {
        env.ORCA_TERMINAL_HANDLE = preAllocatedHandle
      }
      stampWslOrchestrationCompatibilityHost(
        env,
        runtime?.getOrchestrationCompatibilityHostId?.(),
        ctx?.isWsl === true ? ctx.wslDistro : null
      )
      if (ctx?.isWsl === true) {
        addOrcaWslInteropEnv(env)
      }
      return env
    },
    onSpawned: (id, incarnationId) => runtime?.onPtySpawned(id, incarnationId),
    onExit: (id, code, incarnationId, cause) => {
      if (!isCurrentPtyExit({ id, incarnationId })) {
        return
      }
      clearProviderPtyState(id)
      ptyOwnership.delete(id)
      markClaudePtyExited(id)
      runtime?.onPtyExit(id, code, incarnationId, {
        providerExitObserved: true,
        ...(cause ? { cause } : {})
      })
    },
    onData: (id, data, timestamp, sequenceChars, transformed) =>
      runtime?.onPtyData(id, data, timestamp, sequenceChars ?? data.length, transformed)
  })
}
