/** Main answers only queries in chunks hidden delivery dropped; capture ownership at ingestion. Record native Windows ConPTY at spawn to install DA1 override before bytes arrive. */
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  isHiddenPtyDeliveryGateEnabled,
  shouldDropHiddenRendererPtyData
} from '../ipc/pty/delivery/pty-hidden-delivery-gate'

export type TerminalModelQueryAuthoritySettings = Pick<
  GlobalSettings,
  'terminalMainSideEffectAuthority' | 'terminalHiddenDeliveryGate' | 'terminalModelQueryAuthority'
>

/** Require both hidden-delivery switches plus the independent responder switch; otherwise no authoritative drop marks exist. */
export function isTerminalModelQueryAuthorityEnabled(
  settings: TerminalModelQueryAuthoritySettings | null | undefined
): boolean {
  return isHiddenPtyDeliveryGateEnabled(settings) && settings?.terminalModelQueryAuthority !== false
}

/** Capture ownership in the ingestion tick deciding drops; unpaused remote views answer delivered queries, while paused streams drop chunks and yield to main. */
export function shouldModelAnswerHiddenPtyQueries(opts: {
  ptyId: string
  settings: TerminalModelQueryAuthoritySettings | null | undefined
  hasRemoteViewSubscriber: boolean
}): boolean {
  return (
    isTerminalModelQueryAuthorityEnabled(opts.settings) &&
    !opts.hasRemoteViewSubscriber &&
    shouldDropHiddenRendererPtyData(opts.ptyId, opts.settings)
  )
}

/** Mirror renderer native-Windows detection from spawn facts: win32 local/daemon provider, without SSH or WSL. */
export function isNativeWindowsLocalPtySpawn(opts: {
  connectionId: string | null | undefined
  cwd: string | null | undefined
  shellOverride: string | null | undefined
  platform?: NodeJS.Platform
}): boolean {
  if ((opts.platform ?? process.platform) !== 'win32') {
    return false
  }
  if (opts.connectionId) {
    return false
  }
  if (isWslUncPath(opts.cwd ?? '')) {
    return false
  }
  if (/(?:^|[/\\])wsl(?:\.exe)?$/i.test(opts.shellOverride ?? '')) {
    return false
  }
  return true
}

// Spawn records and emulator creation share this state. Adopted PTYs need no mark: blocking ConPTY DA1 already happened at their spawn.
const nativeWindowsConptyPtys = new Set<string>()

// Warm reattach data can create the emulator before the spawn response marks it; installers retrofit the idempotent DA1 override.
type ConptyDa1OverrideInstaller = (ptyId: string) => void
const conptyDa1OverrideInstallers = new Set<ConptyDa1OverrideInstaller>()

export function registerConptyDa1OverrideInstaller(installer: ConptyDa1OverrideInstaller): void {
  conptyDa1OverrideInstallers.add(installer)
}

export function markNativeWindowsConptyPty(id: string): void {
  nativeWindowsConptyPtys.add(id)
  for (const installer of conptyDa1OverrideInstallers) {
    installer(id)
  }
}

export function isNativeWindowsConptyPty(id: string): boolean {
  return nativeWindowsConptyPtys.has(id)
}

/** Wired into clearProviderPtyState so every PTY teardown path releases the
 *  spawn record. */
export function clearNativeWindowsConptyPty(id: string): void {
  nativeWindowsConptyPtys.delete(id)
}

/** Test seam: reset module state between tests. */
export function _resetTerminalModelQueryAuthorityForTest(): void {
  nativeWindowsConptyPtys.clear()
  conptyDa1OverrideInstallers.clear()
}
