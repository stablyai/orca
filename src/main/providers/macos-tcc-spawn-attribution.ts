/**
 * Spawn-time TCC responsibility disclaiming (STA-3631).
 *
 * macOS 26 no longer breaks TCC responsibility inheritance at an intermediate
 * `login(1)` session, so every child of a wrapped pane is still attributed to
 * Orca's bundle. The patched node-pty darwin spawn path calls
 * `responsibility_spawnattrs_setdisclaim` and reports whether it took effect;
 * this module turns that report into a verdict the spawn site can log honestly.
 */

/** Verdict codes emitted by the patched node-pty darwin spawn path. Keep in sync
 *  with ORCA_TCC_DISCLAIM_* in config/patches/node-pty@1.1.0.patch. */
const DISCLAIM_APPLIED = 1
const DISCLAIM_UNSUPPORTED = 2
const DISCLAIM_FAILED = 3

/**
 * Whether this spawn's children get their own TCC identity.
 *
 * `unknown` is the honest default: an unpatched node-pty reports nothing, and
 * `wrapped` never implied isolation on macOS 26 — neither may this.
 */
export type MacosTccAttribution = 'disclaimed' | 'not-disclaimed' | 'unknown'

/** How a pane shell's argv was built, paired with what that actually bought. */
export type MacosTccSpawnStrategy = {
  wrapper: 'wrapped' | 'direct'
  attribution: MacosTccAttribution
}

/**
 * Read the disclaim verdict off a spawned node-pty process.
 *
 * Reports `disclaimed` only on a positive report from the native spawn; a
 * missing, non-numeric, or unrecognized value stays `unknown` so a node-pty
 * without the patch can never be mistaken for an isolated one.
 */
export function readMacosTccAttribution(ptyProcess: unknown): MacosTccAttribution {
  if (process.platform !== 'darwin') {
    return 'unknown'
  }
  // Why: every non-verdict — absent, wrong type, unrecognized code — funnels through
  // the same default, so an unpatched node-pty can never read as isolated.
  const reported = (ptyProcess as { tccDisclaim?: unknown } | null | undefined)?.tccDisclaim
  switch (reported) {
    case DISCLAIM_APPLIED:
      return 'disclaimed'
    case DISCLAIM_UNSUPPORTED:
    case DISCLAIM_FAILED:
      return 'not-disclaimed'
    default:
      return 'unknown'
  }
}
