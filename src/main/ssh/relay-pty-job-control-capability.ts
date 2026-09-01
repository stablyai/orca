/**
 * Whether a deployed relay's node-pty exposes native job-object control.
 *
 * `assignCurrentProcessToJob`, `terminateJob` and `listJobProcessIds` are added
 * by Orca's local pnpm patch of node-pty, and only in its Windows ConPTY
 * sources. A relay installs the stock registry package over SSH, so on every
 * remote the symbols are absent — and nothing said so. `windows-pty-job.ts`
 * feature-detects them and silently takes its `null` branch, which makes a
 * remote that never had the capability look exactly like one where it works.
 *
 * This reports the fact and nothing more. It does not restore the capability,
 * no code path branches on it, and an absence is not an error: PTY teardown
 * keeps using the portable best-effort path it already uses today.
 */
export type RelayPtyJobControlSupport = 'present' | 'absent' | 'unknown'

/** Emitted on its own stdout line by the native-deps probe. */
export const RELAY_PTY_JOB_CONTROL_MARKER = 'ORCA-PTY-JOB-CONTROL:'

const JOB_CONTROL_SYMBOLS = ['assignCurrentProcessToJob', 'terminateJob', 'listJobProcessIds']

/**
 * JS appended to the native-deps probe that feature-detects the three symbols
 * on the module the deps check already loaded.
 *
 * `nativeModuleNameExpr` is the same expression the deps check uses, so this
 * re-reads a module node-pty has already cached rather than paying a second
 * native load.
 */
export function relayPtyJobControlProbeJs(nativeModuleNameExpr: string): string {
  const symbols = JSON.stringify(JOB_CONTROL_SYMBOLS)
  // Why "unknown" on throw: a probe that could not look is not evidence of absence.
  return (
    `let jc="unknown";try{const n=require("node-pty/lib/utils").loadNativeModule(${nativeModuleNameExpr}).module;` +
    // Why the `if`: a loader that hands back no module never let us look, so leave the verdict unanswered.
    `if(n){jc=${symbols}.every(s=>typeof n[s]==="function")?"present":"absent"}}catch{jc="unknown"}` +
    `console.log(${JSON.stringify(RELAY_PTY_JOB_CONTROL_MARKER)}+jc);`
  )
}

/**
 * Read the probe's verdict out of its stdout.
 *
 * No marker means no answer — a relay whose probe never ran, whose deps are
 * missing, or that predates the marker entirely. That is `unknown`, never
 * `absent`: reporting an unanswered probe as a confirmed absence is the same
 * lie this probe exists to remove.
 */
export function readRelayPtyJobControlSupport(probeOutput: string): RelayPtyJobControlSupport {
  const line = probeOutput
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(RELAY_PTY_JOB_CONTROL_MARKER))
  if (!line) {
    return 'unknown'
  }
  const verdict = line.slice(RELAY_PTY_JOB_CONTROL_MARKER.length).trim()
  return verdict === 'present' || verdict === 'absent' ? verdict : 'unknown'
}

/** The one line an operator sees in the deploy log. */
export function describeRelayPtyJobControlSupport(support: RelayPtyJobControlSupport): string {
  switch (support) {
    case 'present':
      return '[ssh-relay] Remote node-pty job control: present (this relay can terminate a PTY process tree by job object)'
    case 'absent':
      return '[ssh-relay] Remote node-pty job control: absent (expected: the symbols are Windows-only and come from a local-only node-pty patch; remote PTY teardown keeps using the portable path)'
    case 'unknown':
      return '[ssh-relay] Remote node-pty job control: unknown (the probe did not answer, so this is not a confirmed absence)'
  }
}
