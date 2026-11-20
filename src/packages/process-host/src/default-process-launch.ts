import type { LaunchedProcess, ProcessSpec } from './process-spec'

type DefaultProcessLaunch = (spec: ProcessSpec, onTerminated: () => void) => LaunchedProcess | null
let defaultLaunch: DefaultProcessLaunch | undefined

/**
 * Main installs where specs without their own `launch` start; null spawns here. `onTerminated` is
 * runProcess's own once-only report, for a launcher that must report an end its child can't.
 */
export function setDefaultProcessLaunch(launch: DefaultProcessLaunch | undefined): void {
  defaultLaunch = launch
}

export function launchByDefault(
  spec: ProcessSpec,
  onTerminated: () => void
): LaunchedProcess | null {
  return defaultLaunch?.(spec, onTerminated) ?? null
}
