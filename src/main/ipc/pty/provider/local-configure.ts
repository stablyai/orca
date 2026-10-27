import { getClaudeAgentViewService } from '../../../claude/agent-view-service'
import { inheritOmpLaunchEnvironment } from '../host-env/omp-launch-environment'
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
import { buildPtyHostEnv } from '../host-env/assembly'
import { stampRuntimeSourceEnv } from '../../../../shared/runtime-source-env'
import { getRuntimeSourceStamp } from '../../../runtime/host-descriptor'
import {
  getCompatibleSelectedCodexHomePath,
  shouldStripInheritedOrcaCodexHome
} from '../host-env/codex-home'
import type { GetSelectedCodexHomePath } from '../host-env/types'
import { isCurrentPtyExit, ptyOwnership } from './ownership-state'
import { localProvider } from './registry'
import { clearProviderPtyState } from './state-cleanup'
import { visibleRendererPtys } from '../delivery/visibility-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { awaitExplicitAgentPluginGuestReadiness } from '../../../agent-hooks/wsl-agent-plugin-readiness'
import { prepareAntigravityAccountForLaunch } from '../../../antigravity/native-account-launch'

export function configureLocalPtyProvider(args: {
  runtime?: OrcaRuntimeService
  getSettings?: () => GlobalSettings
  getSelectedCodexHomePath?: GetSelectedCodexHomePath
  trustedTerminalHandleEnv: Set<string>
}): void {
  // Daemon providers assemble their own environment; configure only the in-process provider.
  if (!(localProvider instanceof LocalPtyProvider)) {
    return
  }
  const { runtime, getSettings, getSelectedCodexHomePath, trustedTerminalHandleEnv } = args
  localProvider.configure({
    isHistoryEnabled: () => getSettings?.()?.terminalScopeHistoryByWorktree ?? true,
    getWindowsShell: () => getSettings?.()?.terminalWindowsShell,
    getDefaultShell: () => getSettings?.()?.terminalDefaultShell,
    getWindowsPowerShellImplementation: () =>
      getSettings ? (getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto') : undefined,
    pwshAvailable: () => isPwshAvailableAsync(),
    buildSpawnEnv: async (id, baseEnv, ctx) => {
      await prepareAntigravityAccountForLaunch({
        launchAgent: ctx?.launchAgent,
        command: ctx?.command,
        isWsl: ctx?.isWsl,
        env: baseEnv,
        envIsComplete: true
      })
      const codexSelectionTarget: CodexAccountSelectionTarget =
        ctx?.isWsl === true
          ? { runtime: 'wsl', wslDistro: ctx.wslDistro ?? null }
          : { runtime: 'host' }
      const selectedCodexHomePath = getCompatibleSelectedCodexHomePath(
        codexSelectionTarget,
        ctx?.codexHomePathOverride
          ? ctx.codexHomePathOverride.value
          : ((await getSelectedCodexHomePath?.(codexSelectionTarget, baseEnv)) ?? null)
      )
      const skipCodexHomeEnv = ctx?.isWsl === true && !selectedCodexHomePath
      const ptySettings = getSettings?.()
      await inheritOmpLaunchEnvironment(baseEnv, {
        shellPath: ctx?.shellPath,
        explicitEnv: ctx?.explicitEnv,
        isWsl: ctx?.isWsl,
        launchAgent: ctx?.launchAgent,
        launchCommand: ctx?.command
      })
      await awaitExplicitAgentPluginGuestReadiness({
        settings: ptySettings,
        isWsl: ctx?.isWsl === true,
        distro: ctx?.wslDistro,
        codexHomePath: selectedCodexHomePath,
        launchAgent: ctx?.launchAgent,
        launchCommand: ctx?.command
      })
      await getClaudeAgentViewService().readyForLaunch({
        settings: ptySettings,
        isWsl: ctx?.isWsl,
        launchAgent: ctx?.launchAgent,
        launchCommand: ctx?.command
      })
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
        shellPath: ctx?.shellPath,
        isWsl: ctx?.isWsl,
        wslDistro: ctx?.wslDistro ?? null,
        agentStatusHooksEnabled: isAgentStatusHooksEnabled(ptySettings),
        claudeSubagentNavigationEnabled: ptySettings?.claudeSubagentNavigationEnabled,
        terminalInlineImages: ptySettings?.terminalInlineImages,
        disabledTuiAgents: ptySettings?.disabledTuiAgents,
        networkProxySettings: ptySettings,
        routeBrowserOpensToClient: runtime?.shouldRelayTerminalBrowserOpens?.()
      })
      // Supply terminal identity at process start so agents can address orchestration without another RPC.
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
      stampRuntimeSourceEnv(
        env,
        getRuntimeSourceStamp(runtime, getAppEnvironment().getPath('userData'))
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
      const viewShown = ORCA_LAYOUT_OWNER_IS_MAIN && visibleRendererPtys.has(id)
      clearProviderPtyState(id)
      ptyOwnership.delete(id)
      runtime?.onPtyExit(id, code, incarnationId, {
        providerExitObserved: true,
        ...(viewShown ? { viewShown } : {}),
        ...(cause ? { cause } : {})
      })
    },
    onData: (id, data, timestamp, sequenceChars, transformed) =>
      runtime?.onPtyData(id, data, timestamp, sequenceChars ?? data.length, transformed)
  })
}
