import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  isCodexHomeAuthReadyForLaunch,
  waitForManagedCodexAuthReady
} from '../../../codex-accounts/managed-codex-auth-readiness'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import {
  forgetCodexPaneAccount,
  getCodexPaneAccount,
  recordCodexPaneAccount,
  type CodexPaneHomeRoute
} from '../../../codex/codex-pane-account-registry'
import { resolveCodexPaneLaunchAccount } from '../../../codex/codex-pane-launch-account'
import { getSystemCodexHomePath } from '../../../codex/codex-home-paths'
import { isHostCodexHomeForWsl, isWslCodexHomeForHost } from '../../../pty/codex-home-wsl-env'
import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'
import { parseWslPath } from '../../../wsl'

export function shouldSkipCodexHomeEnvForWindowsShell(
  shellPath: string | undefined,
  cwd: string | undefined
): boolean {
  return isWslShellName(shellPath) || (typeof cwd === 'string' && parseWslPath(cwd) !== null)
}

// System-default real-home launches must remove inherited Orca overrides when no managed home is selected.
export function shouldStripInheritedOrcaCodexHome(args: {
  target: CodexAccountSelectionTarget
  selectedCodexHomePath: string | null
  skipCodexHomeEnv: boolean
  settings: GlobalSettings | undefined
}): boolean {
  return (
    args.target.runtime === 'host' && args.selectedCodexHomePath === null && !args.skipCodexHomeEnv
  )
}

export const CODEX_HOME_ENV_KEYS = ['CODEX_HOME', 'ORCA_CODEX_HOME'] as const

// Remove only overrides matching Orca's private marker, then drop the marker so wrappers cannot restore them; preserve user CODEX_HOME (#8606).
export function stripInheritedOrcaCodexHomeOverride(baseEnv: Record<string, string>): void {
  for (const key of getLocalOrcaCodexHomeEnvKeysToDelete(baseEnv)) {
    delete baseEnv[key]
  }
}

// Local spawns share this environment; persistent daemons must compare their own inherited values.
export function getLocalOrcaCodexHomeEnvKeysToDelete(env: Record<string, string>): string[] {
  const inheritedOrcaOverride = env.ORCA_CODEX_HOME ?? process.env.ORCA_CODEX_HOME
  const inheritedCodexHome = env.CODEX_HOME ?? process.env.CODEX_HOME
  const keysToDelete = ['ORCA_CODEX_HOME']
  if (inheritedOrcaOverride && inheritedCodexHome === inheritedOrcaOverride) {
    keysToDelete.push('CODEX_HOME')
  }
  return keysToDelete
}

export function getCodexSelectionTargetForPty(
  shellPath: string | undefined,
  cwd: string | undefined,
  wslDistro?: string | null
): CodexAccountSelectionTarget {
  const wslPath = typeof cwd === 'string' ? parseWslPath(cwd) : null
  if (isWslShellName(shellPath) || wslPath) {
    return { runtime: 'wsl', wslDistro: wslPath?.distro ?? wslDistro ?? null }
  }
  return { runtime: 'host' }
}

export function getCompatibleSelectedCodexHomePath(
  target: CodexAccountSelectionTarget,
  selectedCodexHomePath: string | null
): string | null {
  if (!selectedCodexHomePath) {
    return null
  }
  const wslInfo = parseWslPath(selectedCodexHomePath)
  if (target.runtime === 'wsl') {
    return wslInfo || !isHostCodexHomeForWsl(selectedCodexHomePath) ? selectedCodexHomePath : null
  }
  return wslInfo || (process.platform === 'win32' && isWslCodexHomeForHost(selectedCodexHomePath))
    ? null
    : selectedCodexHomePath
}

export const MANAGED_CODEX_AUTH_UNAVAILABLE_MESSAGE =
  'The selected Codex account credentials are temporarily unavailable. Try opening the terminal again.'
export const CODEX_RESUME_AUTH_UNAVAILABLE_MESSAGE =
  'The Codex account credentials for this session are temporarily unavailable. Try opening the terminal again.'

type ManagedCodexAuthResolutionArgs = {
  selectedCodexHomePath: string | null
  getSettings: () => GlobalSettings | undefined
  requiredCodexHomePath?: string
  target: CodexAccountSelectionTarget
  resolveCurrent: () => string | null | Promise<string | null>
  resolveAfterUnavailable: (
    unavailableManagedHomePath: string
  ) => string | null | Promise<string | null>
}

export function resolveCodexHomeAfterManagedAuthReadiness(
  args: ManagedCodexAuthResolutionArgs
): string | null | Promise<string | null> {
  const selectedCodexHomePath = args.selectedCodexHomePath
  if (
    args.requiredCodexHomePath &&
    !codexHomePathsEqual(selectedCodexHomePath, args.requiredCodexHomePath)
  ) {
    throw new Error(CODEX_RESUME_AUTH_UNAVAILABLE_MESSAGE)
  }
  const readiness = waitForManagedCodexAuthReady({
    codexHomePath: selectedCodexHomePath,
    settings: args.getSettings(),
    target: args.target
  })
  return readiness
    ? continueCodexHomeAfterManagedAuthWait(args, selectedCodexHomePath, readiness)
    : selectedCodexHomePath
}

async function continueCodexHomeAfterManagedAuthWait(
  args: ManagedCodexAuthResolutionArgs,
  initialCodexHomePath: string | null,
  initialReadiness: Promise<boolean>
): Promise<string | null> {
  let selectedCodexHomePath = initialCodexHomePath
  let readiness = initialReadiness
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await readiness) {
      if (args.requiredCodexHomePath) {
        return selectedCodexHomePath
      }
      const currentCodexHomePath = await args.resolveCurrent()
      if (codexHomeSelectionsEqual(selectedCodexHomePath, currentCodexHomePath)) {
        return selectedCodexHomePath
      }
      selectedCodexHomePath = currentCodexHomePath
      if (attempt === 1) {
        break
      }
      const nextReadiness = waitForManagedCodexAuthReady({
        codexHomePath: selectedCodexHomePath,
        settings: args.getSettings(),
        target: args.target
      })
      if (!nextReadiness) {
        return selectedCodexHomePath
      }
      readiness = nextReadiness
      continue
    }
    if (args.requiredCodexHomePath) {
      throw new Error(CODEX_RESUME_AUTH_UNAVAILABLE_MESSAGE)
    }
    selectedCodexHomePath = await args.resolveAfterUnavailable(selectedCodexHomePath!)
    if (attempt === 1) {
      break
    }
    const nextReadiness = waitForManagedCodexAuthReady({
      codexHomePath: selectedCodexHomePath,
      settings: args.getSettings(),
      target: args.target
    })
    if (!nextReadiness) {
      return selectedCodexHomePath
    }
    readiness = nextReadiness
  }
  if (
    isCodexHomeAuthReadyForLaunch({
      codexHomePath: selectedCodexHomePath,
      settings: args.getSettings(),
      target: args.target
    })
  ) {
    return selectedCodexHomePath
  }
  throw new Error(MANAGED_CODEX_AUTH_UNAVAILABLE_MESSAGE)
}

export function codexHomeSelectionsEqual(left: string | null, right: string | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right))
  )
}

export function codexHomePathsEqual(left: string | null, right: string): boolean {
  return codexHomeSelectionsEqual(left, right)
}

// Reattach retains the shell's original CODEX_HOME; recording the current selection would hide stale-account panes.
export function recordCodexPaneAccountForSpawn(args: {
  ptyId: string | undefined
  isDaemonHostSpawn: boolean
  isReattach: boolean
  pinnedByResume: boolean
  launchCodexHomePath: string | null
  target: CodexAccountSelectionTarget
  settings: GlobalSettings | undefined
}): void {
  if (!args.ptyId || !args.isDaemonHostSpawn || args.isReattach) {
    return
  }
  const record = args.settings
    ? resolveCodexPaneLaunchAccount({
        pinnedByResume: args.pinnedByResume,
        launchCodexHomePath: args.launchCodexHomePath,
        systemCodexHomePath: getSystemCodexHomePath(),
        settings: args.settings,
        target: args.target
      })
    : null
  if (!record) {
    forgetCodexPaneAccount(args.ptyId)
    return
  }
  recordCodexPaneAccount(args.ptyId, record)
}

export function snapshotCodexPaneHomeRoutes(
  ptyIds: readonly (string | null | undefined)[]
): ReadonlyMap<string, CodexPaneHomeRoute | null> {
  const routes = new Map<string, CodexPaneHomeRoute | null>()
  for (const ptyId of ptyIds) {
    if (!ptyId || routes.has(ptyId)) {
      continue
    }
    routes.set(ptyId, getCodexPaneAccount(ptyId)?.homeRoute ?? null)
  }
  return routes
}

export function codexReattachedHomeRouteField(
  routes: ReadonlyMap<string, CodexPaneHomeRoute | null>,
  ptyId: string,
  reattached: boolean
): { reattachedHomeRoute?: CodexPaneHomeRoute | null } {
  if (!reattached || !routes.has(ptyId)) {
    return {}
  }
  return { reattachedHomeRoute: routes.get(ptyId) ?? null }
}
