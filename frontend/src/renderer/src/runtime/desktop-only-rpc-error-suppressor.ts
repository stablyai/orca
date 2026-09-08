/**
 * desktop-only-rpc-error-suppressor.ts — swallows the console-red
 * "Uncaught (in promise) RuntimeRpcCallError: Unknown method: X" noise for
 * RPC namespaces that only make sense in Electron desktop mode and are
 * deliberately NOT implemented in server/web mode (native file dialogs,
 * OS auto-updater, local CLI install, mobile LAN pairing, OS permission
 * prompts...). See specs/backend/api/desktop-only-rpc-parity-gaps.md
 * "Group A" for the full list + per-namespace rationale.
 *
 * Why a single global listener instead of guarding ~99 individual call
 * sites: those call sites are scattered across dozens of files, most only
 * reachable from Settings screens/features that may not even render in web
 * mode — retrofitting every one is a large, low-value change for a problem
 * that's really "this class of error is expected and not actionable here."
 * One `unhandledrejection` listener that recognizes the shape
 * (`RuntimeRpcCallError` + `code: 'method_not_found'` + a known desktop-only
 * namespace) and calls `event.preventDefault()` covers all of them at once,
 * without changing behavior for any OTHER unhandled rejection (those still
 * log normally — this only touches the specific "known, expected,
 * feature-not-available-here" case).
 *
 * NOT a substitute for actually porting a namespace: if a namespace moves
 * from "desktop-only" to "ported", remove it from `DESKTOP_ONLY_NAMESPACES`
 * below so a real regression (the newly-ported method itself going missing)
 * surfaces again instead of being silently swallowed.
 *
 * @module runtime/desktop-only-rpc-error-suppressor
 */

// Keep in sync with "Group A" in specs/backend/api/desktop-only-rpc-parity-gaps.md.
// Why 'cli'/'agentTrust' are gone from this list (2026-08-16): both moved to
// a real backend-proxies-to-Dev-Server-Agent implementation — see
// backend/src/main/runtime/rpc/methods/cli.ts and agent-trust.ts. A
// "Unknown method" for either now is a REAL bug (e.g. no connected Dev
// Server), not an expected desktop-only gap — do not re-add them here.
// 'shell' stays: only shell.pick*/pathExists/copyFile's UI call sites were
// rewired to a new in-app picker (DevServerFilePickerDialog) that bypasses
// the RPC entirely in web mode; 2 call sites (chat attachment picker,
// UntitledFileRenameDialog's directory pick) were NOT rewired yet and can
// still hit 'shell.*' as Unknown method — remove 'shell' once those land too.
// 'orcaProfiles' added 2026-08-17 (see specs/backend/api/orca-profiles-server-mode-design.md):
// desktop's local multi-profile switcher (Chrome/Firefox-style — one machine,
// swappable local app identity, `switch` relaunches the whole process). Not
// the same concept as backend's `profile.*`/ProfileService (Company→Dept→
// Team→User Postgres cascade for an already-authenticated server user) — the
// shared "profile" name is coincidental. No server-mode analogue exists for
// "which local machine identity is this process currently running as."
// 'remoteWorkspace' added 2026-08-17: syncs open tabs/panes for an SSH
// target across multiple separate desktop app processes via a snapshot file
// on the remote host's Dev Server Agent (see agent/src/relay/workspace-session-handler.ts).
// The problem it solves — many local Stores needing sync through a third
// machine — doesn't exist in server mode, where one backend's single
// Postgres-backed WorkspaceSessionState is already the one source of truth
// every browser client reads directly. Not the mobile-pairing bridge
// (that's the unrelated 'mobile' namespace) and not a duplicate of
// devServer.list ("which Dev Servers are connected" is a different concept).
// 'speech' added 2026-09-07 (see specs/backend-go/bugs/missing-v3/solutions/
// SOL-006-speech-models-channels.md): speech-model list/download/delete for
// voice dictation always targets the one paired desktop process holding the
// downloaded ONNX model files and (for OpenAI-provider entries) a dedicated
// local speech API-key store — dictation never routes to a worktree's SSH
// host or a repo's Dev Server (desktop/src/main/runtime/orca-runtime-mobile-dictation.ts:45-46's
// own comment). Unlike ephemeralVm.*/browser.*, there is no dev-server/
// worktree resolution step to port: a backend-go environment is a
// stateless, horizontally-scaled pod fleet with no durable single-machine
// analogue to relay this to. Remove this entry only if that verdict is
// revisited AND a real implementation ships — see that solution doc's "If
// this verdict is ever revisited" section for the two conditions that would
// need to hold first.
// 'ephemeralVm' removed 2026-09-08 (CR-EVM-002 / FE-SOL-EVM-001 §1's
// direction (b)): 9 of 12 ephemeralVm.* methods now have a real backend-go
// implementation (SOL-004/TASK-004/TASK-005) — an "Unknown method" for one
// of those is a real regression again, not an expected desktop-only gap.
// The remaining 3 (provision/cancelProvision/onProvisionEvent, see
// EPHEMERAL_VM_METHODS in desktop/src/main/runtime/rpc/methods/ephemeral-vm.ts)
// still have no RPC route and will surface real, expected console errors in
// paired/web mode until FE-SOL-EVM-002 ships — accepted as a short-lived
// cost rather than reintroducing a namespace-wide suppression.
const DESKTOP_ONLY_NAMESPACES: ReadonlySet<string> = new Set([
  'shell',
  'mobile',
  'app',
  'updater',
  'pet',
  'ui',
  'computerUsePermissions',
  'developerPermissions',
  'e2e',
  'export',
  'localhostWorktreeLabels',
  'orcaProfiles',
  'remoteWorkspace',
  'speech'
])

const UNKNOWN_METHOD_PATTERN = /^Unknown method: ([a-zA-Z0-9_]+)\./

let installed = false

export function installDesktopOnlyRpcErrorSuppressor(): void {
  if (installed || typeof window === 'undefined') {
    return
  }
  installed = true
  window.addEventListener('unhandledrejection', handleUnhandledRejection)
}

export function _uninstallDesktopOnlyRpcErrorSuppressorForTests(): void {
  if (!installed || typeof window === 'undefined') {
    return
  }
  installed = false
  window.removeEventListener('unhandledrejection', handleUnhandledRejection)
}

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  const namespace = desktopOnlyNamespaceFor(event.reason)
  if (!namespace) {
    return
  }
  // Why preventDefault(), not stopImmediatePropagation(): other listeners
  // (e.g. crash-diagnostics.ts's breadcrumb recorder) should still run
  // normally — this only suppresses the browser's own default "log this to
  // console as an error" behavior for the specific known-safe case.
  event.preventDefault()
  console.debug(
    `[desktop-only-rpc] ${namespace}.* not available in this runtime mode (expected) — suppressed console error for:`,
    event.reason instanceof Error ? event.reason.message : event.reason
  )
}

function desktopOnlyNamespaceFor(reason: unknown): string | null {
  if (!(reason instanceof Error) || reason.name !== 'RuntimeRpcCallError') {
    return null
  }
  const code = (reason as Error & { code?: unknown }).code
  if (code !== 'method_not_found') {
    return null
  }
  const match = UNKNOWN_METHOD_PATTERN.exec(reason.message)
  const namespace = match?.[1]
  if (!namespace || !DESKTOP_ONLY_NAMESPACES.has(namespace)) {
    return null
  }
  return namespace
}
