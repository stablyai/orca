import { runProcess } from '../../shared/child-process/run-process'
import {
  isZCodeMissingTuiOutput,
  type ZCodeInteractiveCapability
} from '../../shared/zcode-missing-tui'

/**
 * Asking a `zcode` build whether it can open a session, before Orca opens a pane for it.
 *
 * Why a deliberate probe and not a rule over the pane's output: the failure lands within
 * about half a second of spawn, so anything watching a live stream races it. Asking the
 * question directly is race-free, answerable once, and can run before the user ever sees a
 * terminal.
 *
 * Why running it is the only way to ask: ZCode's `--version` and `doctor` are identical
 * between a build that has the TUI and one that does not (measured on both), because the
 * TUI is only ever touched on the `tui` command path — `runTuiCommand` calls
 * `loadTuiRuntime()` before anything else, and every other subcommand returns without it.
 *
 * That same ordering is what makes the answer unambiguous. With no TTY:
 *   - a build WITHOUT the TUI fails in `loadTuiRuntime` → Node's module-resolution error
 *   - a build WITH the TUI loads, then `runTui` rejects the missing TTY
 * so the module error is present exactly when the terminal UI is absent.
 *
 * All three shipping shapes land correctly: an npm/node-bundle install resolves
 * `@zcode/tui` as a real package (it is an esbuild external, never inlined); a SEA build
 * always carries the TUI as embedded assets; and the desktop app's bundled runtime carries
 * neither, which is the case worth catching.
 */
export type { ZCodeInteractiveCapability }

// Why bounded: the answer arrives in well under a second on both builds measured. A hang
// means something unexpected, and an unexpected build must not be called broken.
const PROBE_TIMEOUT_MS = 6_000

let cached: ZCodeInteractiveCapability | undefined
let inFlight: Promise<ZCodeInteractiveCapability> | undefined

export function _resetZCodeInteractiveCapabilityForTests(): void {
  cached = undefined
  inFlight = undefined
}

async function probe(command: string): Promise<ZCodeInteractiveCapability> {
  try {
    const result = await runProcess({
      program: command,
      args: [],
      // Why an explicit empty stdin: the child gets a pipe at EOF rather than a terminal, so
      // a build that HAS the TUI declines instead of taking the probe interactive.
      input: '',
      timeoutMs: PROBE_TIMEOUT_MS
    })
    if (result.timedOut) {
      return 'unknown'
    }
    return isZCodeMissingTuiOutput(`${result.stderr}\n${result.stdout}`)
      ? 'missing-tui'
      : 'interactive'
  } catch {
    // Why fail open: a spawn that never ran says nothing about the build. Reporting
    // 'missing-tui' here would accuse a perfectly good CLI on an unrelated failure.
    return 'unknown'
  }
}

/** Whether this `zcode` can open a session. Answered once per Orca run. */
export function readZCodeInteractiveCapability(
  command = 'zcode'
): Promise<ZCodeInteractiveCapability> {
  if (cached !== undefined) {
    return Promise.resolve(cached)
  }
  inFlight ??= probe(command).then((verdict) => {
    // Why only remember a definitive answer: 'unknown' is usually transient (a timeout, a
    // spawn refused under load), and caching it would suppress the notice for the session.
    if (verdict !== 'unknown') {
      cached = verdict
    }
    inFlight = undefined
    return verdict
  })
  return inFlight
}
