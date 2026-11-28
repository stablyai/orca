import { nativeTheme, type IpcMainInvokeEvent } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { AgentAwakeService } from '../../power/agent-awake-service'
import { sanitizeRendererSettingsUpdate } from './renderer-settings-update'
import { sanitizeFloatingWorkspaceDirectorySetting } from '../worktrees/floating-workspace-directory'
import { sanitizeNetworkSettings } from './network-settings-sanitization'
import { normalizeAppIconId } from '../../../shared/app-lifecycle/identity/app-icon'
import { normalizeUiLanguage } from '../../../shared/i18n/ui-language'
import { normalizeTerminalCustomThemes } from '../../../shared/terminal-themes/terminal-custom-themes'
import { normalizeDesktopTerminalScrollbackRows } from '../../../shared/terminal/replay/terminal-scrollback-policy'
import { normalizeTerminalLineHeight } from '../../../shared/terminal/appearance/terminal-line-height-settings'
import {
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses
} from '../../../shared/remote-runtime/pairing/mobile-pairing-custom-address'
import {
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode
} from '../../../shared/app-lifecycle/computer-awake-mode'
import { resolveAiVaultSearchSettings } from '../../../shared/ai-vault/search/ai-vault-search-settings'

export async function handleSettingsSet(
  store: Store,
  agentAwakeService: AgentAwakeService | undefined,
  event: IpcMainInvokeEvent,
  args: Partial<GlobalSettings>
): Promise<{
  sanitizedArgs: Partial<GlobalSettings>
  before: GlobalSettings
  result: GlobalSettings
}> {
  const sanitizedArgs = sanitizeRendererSettingsUpdate(args)
  // Generic settings writers cannot change the server preference owned by Advanced controls.
  delete sanitizedArgs.activeRuntimeEnvironmentId
  // Only the main-process directory picker may grant trusted floating-workspace paths.
  delete sanitizedArgs.floatingTerminalTrustedCwds
  if ('computerAwakeMode' in sanitizedArgs) {
    Object.assign(
      sanitizedArgs,
      computerAwakeSettingsForMode(
        normalizeComputerAwakeMode(
          sanitizedArgs.computerAwakeMode,
          sanitizedArgs.keepComputerAwakeWhileAgentsRun
        )
      )
    )
  } else if ('keepComputerAwakeWhileAgentsRun' in sanitizedArgs) {
    Object.assign(
      sanitizedArgs,
      computerAwakeSettingsForMode(sanitizedArgs.keepComputerAwakeWhileAgentsRun ? 'auto' : 'off')
    )
  }
  if (typeof args.floatingTerminalCwd === 'string') {
    sanitizedArgs.floatingTerminalCwd = await sanitizeFloatingWorkspaceDirectorySetting(
      store,
      args.floatingTerminalCwd
    )
  }
  sanitizeNetworkSettings(args, sanitizedArgs)
  if ('appIcon' in args) {
    sanitizedArgs.appIcon = normalizeAppIconId(args.appIcon)
  }
  if ('aiVaultSearch' in args) {
    sanitizedArgs.aiVaultSearch = resolveAiVaultSearchSettings(args)
  }
  if ('terminalCustomThemes' in args) {
    sanitizedArgs.terminalCustomThemes = normalizeTerminalCustomThemes(args.terminalCustomThemes)
  }
  if ('terminalScrollbackRows' in args) {
    sanitizedArgs.terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
      args.terminalScrollbackRows
    )
  }
  if ('terminalLineHeight' in args) {
    sanitizedArgs.terminalLineHeight = normalizeTerminalLineHeight(args.terminalLineHeight)
  }
  if ('uiLanguage' in args) {
    sanitizedArgs.uiLanguage = normalizeUiLanguage(args.uiLanguage)
  }
  if ('mobilePairingCustomAddress' in args) {
    sanitizedArgs.mobilePairingCustomAddress = normalizeMobilePairingCustomAddress(
      args.mobilePairingCustomAddress
    )
  }
  if ('mobilePairingCustomAddresses' in args) {
    sanitizedArgs.mobilePairingCustomAddresses = normalizeMobilePairingCustomAddresses(
      args.mobilePairingCustomAddresses
    )
  }
  if (args.theme) {
    nativeTheme.themeSource = args.theme
  }
  if (sanitizedArgs.browserPasswordsFillRequiresReauth === false) {
    const { confirmBrowserPasswordOwner } =
      await import('../../browser-passwords/browser-password-reauth')
    if (
      store.getSettings().browserPasswordsFillRequiresReauth !== true ||
      !(await confirmBrowserPasswordOwner('turn off saved password fill authentication', {
        always: true
      }))
    ) {
      delete sanitizedArgs.browserPasswordsFillRequiresReauth
    }
  }
  // No-op UI saves must not inflate settings_changed adoption telemetry.
  const before = store.getSettings()
  const updateOptions = {
    notifyListeners: true,
    originWebContentsId: event.sender.id
  }
  const result =
    'alwaysForceDeleteWorktrees' in sanitizedArgs ||
    'alwaysForceDeletePreservedBranches' in sanitizedArgs
      ? await store.updateSettingsAndFlush(sanitizedArgs, updateOptions)
      : store.updateSettings(sanitizedArgs, updateOptions)
  const { applySettingsUpdateSideEffects } = await import('./settings-update-side-effects')
  await applySettingsUpdateSideEffects({
    store,
    agentAwakeService,
    sanitizedArgs,
    before,
    result
  })
  return { sanitizedArgs, before, result }
}
