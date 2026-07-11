/**
 * Phase 5 of the terminal model/view architecture: main-side terminal query
 * authority (docs/reference/terminal-query-authority.md).
 *
 * The delivery decision is the reply decision: main answers a query iff the
 * hidden-delivery gate dropped the chunk that carried it. This module owns
 * the responder kill-switch predicate and the main-side mirror of the
 * renderer's native-Windows-ConPTY determination, recorded per PTY at spawn
 * so the runtime emulator can register the DA1 override before byte zero.
 */
import type { GlobalSettings } from '../../shared/types'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  isHiddenPtyDeliveryGateEnabled,
  shouldDropHiddenRendererPtyData
} from '../ipc/pty-hidden-delivery-gate'

export type TerminalModelQueryAuthoritySettings = Pick<
  GlobalSettings,
  'terminalMainSideEffectAuthority' | 'terminalHiddenDeliveryGate' | 'terminalModelQueryAuthority'
>

/** Responder kill switch: requires BOTH Phase-4 gate switches (no marks/drops
 *  exist without them) plus the Phase-5-specific independent off switch. */
export function isTerminalModelQueryAuthorityEnabled(
  settings: TerminalModelQueryAuthoritySettings | null | undefined
): boolean {
  return isHiddenPtyDeliveryGateEnabled(settings) && settings?.terminalModelQueryAuthority !== false
}

/** Per-chunk reply-ownership predicate, evaluated once at ingestion in
 *  OrcaRuntimeService.onPtyData — the same module state and tick as the
 *  hidden-gate drop sites, so "chunk dropped" and "main answers" cannot
 *  diverge for live chunks. Remote view subscribers (mobile/web/remote
 *  desktop xterms on the multiplexed stream) keep view authority, so main
 *  yields while one is attached. */
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

/** Main-side mirror of the renderer's isLocalNativeWindowsPty
 *  (windows-pty-compatibility.ts), computed from spawn-time facts: local or
 *  daemon provider (no SSH connection), win32 host, and not a WSL shell. */
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

// Why module state (pattern of pty-hidden-delivery-gate.ts): pty.ts records
// the determination at spawn, the runtime consults it at emulator creation.
// Daemon-adopted PTYs from a previous app run carry no mark — acceptable:
// ConPTY's blocking DA1 only fires at spawn, which happened in a prior life.
const nativeWindowsConptyPtys = new Set<string>()

// Why installers: the mark lands after the awaited spawn response, but daemon
// stream data (warm-reattach flush) can lazy-create the runtime emulator
// first. The runtime registers an installer so marking retrofits the DA1
// override onto an existing emulator; installation is idempotent emulator-side.
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
