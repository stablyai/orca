import { runProcess } from '@orca/process-host'
import {
  isZCodeMissingTuiOutput,
  type ZCodeInteractiveCapability
} from '../../shared/zcode-missing-tui'

/** Probe before opening a pane to avoid racing fast startup failure. version/doctor never load TUI; no-TTY launch distinguishes missing @zcode/tui from loaded UI rejecting a terminal. npm resolves the package, SEA embeds assets, bundled desktop lacks both. */
export type { ZCodeInteractiveCapability }

// Measured answers arrive under a second; timeouts mean unknown, never proven missing TUI.
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
      // Pipe explicit EOF so capable builds reject missing TTY instead of taking the probe interactive.
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
    // Spawn failure proves no capability; preserve unknown rather than accuse a healthy CLI.
    return 'unknown'
  }
}

/** Cache definitive capability for this process; transient unknown verdicts may retry. */
export function readZCodeInteractiveCapability(
  command = 'zcode'
): Promise<ZCodeInteractiveCapability> {
  if (cached !== undefined) {
    return Promise.resolve(cached)
  }
  inFlight ??= probe(command).then((verdict) => {
    // Retry transient unknowns so temporary load cannot suppress the missing-TUI notice for the whole session.
    if (verdict !== 'unknown') {
      cached = verdict
    }
    inFlight = undefined
    return verdict
  })
  return inFlight
}
