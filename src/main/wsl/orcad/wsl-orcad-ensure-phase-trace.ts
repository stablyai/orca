/** Real-distro lane only: splits one WSL host connect into phases from wrapper marks and guest-command start times. */

export type WslOrcadEnsureMark =
  | 'ensure-start'
  | 'deploy-start'
  | 'holder-start'
  | 'holder-end'
  | 'deploy-end'
  | 'bridge-start'
  | 'bridge-end'
  | 'pairing-start'
  | 'pairing-end'
  | 'ensure-end'

export type WslOrcadEnsureTraceEvent =
  | { kind: 'mark'; mark: WslOrcadEnsureMark; atMs: number }
  | { kind: 'command'; command: string; atMs: number }

export type WslOrcadEnsurePhases = {
  totalMs: number
  /** Connect bookkeeping before the deploy starts (E9 gate, transport). */
  gateMs: number
  /** The first guest command (`uname -r`), which boots a stopped distro. */
  firstExecAndBootMs: number
  holderMs: number
  preLaunchChecksMs: number
  preLaunchCommands: number
  /** Null when orcad was already serving, so nothing launched. */
  launchMs: number | null
  /** orcad's own startup until its readiness file is written. */
  orcadStartupMs: number | null
  postReadinessMs: number
  postReadinessCommands: number
  bridgeMs: number
  pairingMs: number
  unattributedMs: number
}

// Fragments of the setsid launch tail and the on-host readiness wait (orcad-remote-launch / -readiness-wait).
const LAUNCH_FRAGMENT = ' orcad-launch '
const READINESS_WAIT_FRAGMENT = 'orcad_readiness_wait_end'

export function createWslOrcadEnsureTrace(now: () => number = () => performance.now()) {
  const events: WslOrcadEnsureTraceEvent[] = []
  const mark = (name: WslOrcadEnsureMark): void => {
    events.push({ kind: 'mark', mark: name, atMs: now() })
  }
  return {
    events,
    mark,
    command(command: string): void {
      events.push({ kind: 'command', command, atMs: now() })
    },
    async span<T>(start: WslOrcadEnsureMark, end: WslOrcadEnsureMark, run: () => Promise<T>) {
      mark(start)
      try {
        return await run()
      } finally {
        mark(end)
      }
    }
  }
}

export function summarizeWslOrcadEnsurePhases(
  events: readonly WslOrcadEnsureTraceEvent[]
): WslOrcadEnsurePhases | null {
  const at = (mark: WslOrcadEnsureMark): number | null =>
    events.find((event) => event.kind === 'mark' && event.mark === mark)?.atMs ?? null
  const ensureStart = at('ensure-start')
  const ensureEnd = at('ensure-end')
  const deployStart = at('deploy-start')
  const deployEnd = at('deploy-end')
  const holderStart = at('holder-start')
  const holderEnd = at('holder-end')
  if (
    ensureStart === null ||
    ensureEnd === null ||
    deployStart === null ||
    deployEnd === null ||
    holderStart === null ||
    holderEnd === null
  ) {
    return null
  }
  const commands = events.flatMap((event) =>
    event.kind === 'command' && event.atMs >= holderEnd && event.atMs <= deployEnd ? [event] : []
  )
  const launchIndex = commands.findIndex((event) => event.command.includes(LAUNCH_FRAGMENT))
  let startupEndIndex = launchIndex + 1
  while (commands[startupEndIndex]?.command.includes(READINESS_WAIT_FRAGMENT)) {
    startupEndIndex++
  }
  const launched = launchIndex !== -1 && startupEndIndex > launchIndex + 1
  const launchAt = launched ? commands[launchIndex].atMs : deployEnd
  const readinessAt = launched ? commands[launchIndex + 1].atMs : null
  const startupEndAt = launched ? (commands[startupEndIndex]?.atMs ?? deployEnd) : deployEnd
  const spanSum = (start: WslOrcadEnsureMark, end: WslOrcadEnsureMark): number => {
    let total = 0
    let opened: number | null = null
    for (const event of events) {
      if (event.kind !== 'mark') {
        continue
      }
      if (event.mark === start) {
        opened = event.atMs
      } else if (event.mark === end && opened !== null) {
        total += event.atMs - opened
        opened = null
      }
    }
    return total
  }
  const round = Math.round
  const phases = {
    totalMs: round(ensureEnd - ensureStart),
    gateMs: round(deployStart - ensureStart),
    firstExecAndBootMs: round(holderStart - deployStart),
    holderMs: round(holderEnd - holderStart),
    preLaunchChecksMs: round(launchAt - holderEnd),
    preLaunchCommands: launched ? launchIndex : commands.length,
    launchMs: readinessAt === null ? null : round(readinessAt - launchAt),
    orcadStartupMs: readinessAt === null ? null : round(startupEndAt - readinessAt),
    postReadinessMs: launched ? round(deployEnd - startupEndAt) : 0,
    postReadinessCommands: launched ? commands.length - startupEndIndex : 0,
    bridgeMs: round(spanSum('bridge-start', 'bridge-end')),
    pairingMs: round(spanSum('pairing-start', 'pairing-end'))
  }
  const attributed =
    phases.gateMs +
    phases.firstExecAndBootMs +
    phases.holderMs +
    round(deployEnd - holderEnd) +
    phases.bridgeMs +
    phases.pairingMs
  return { ...phases, unattributedMs: phases.totalMs - attributed }
}

/** Per-phase median over runs; a phase some run could not measure is left out. */
export function medianWslOrcadEnsurePhases(
  runs: readonly (WslOrcadEnsurePhases | null)[]
): Record<string, number> {
  const measured = runs.filter((run): run is WslOrcadEnsurePhases => run !== null)
  const medians: Record<string, number> = {}
  for (const key of Object.keys(measured[0] ?? {})) {
    const values = measured
      .map((run) => Object.entries(run).find(([name]) => name === key)?.[1])
      .filter((value): value is number => typeof value === 'number')
      .toSorted((a, b) => a - b)
    if (values.length === measured.length && values.length > 0) {
      medians[key] = values[Math.floor((values.length - 1) / 2)]
    }
  }
  return medians
}
