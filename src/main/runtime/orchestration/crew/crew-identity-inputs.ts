import type { CrewReadDependencies } from './crew-read-model'

/** Capture each runtime identity fact once in the host input generation, including absent facts. */
export function captureCrewIdentityInputs(deps: CrewReadDependencies): CrewReadDependencies {
  const { statuses, ...sources } = deps
  if (deps.openIdentityRead) {
    return { ...sources, statuses: structuredClone(statuses) }
  }
  const capture = <T>(read: (key: string) => T) => {
    const facts = new Map<string, T>()
    return (key: string): T => {
      if (!facts.has(key)) {
        facts.set(key, read(key))
      }
      return facts.get(key)!
    }
  }
  let maximum: number | undefined
  return {
    ...sources,
    statuses: structuredClone(statuses),
    maxDepth: deps.maxDepth ? () => (maximum ??= deps.maxDepth!()) : undefined,
    callerProjection: deps.callerProjection ? capture(deps.callerProjection) : undefined,
    liveHandle: capture(deps.liveHandle),
    handleForPane: capture(deps.handleForPane),
    paneForHandle: capture(deps.paneForHandle),
    callerPaneForHandle: deps.callerPaneForHandle ? capture(deps.callerPaneForHandle) : undefined,
    livePaneForHandle: deps.livePaneForHandle ? capture(deps.livePaneForHandle) : undefined,
    processForHandle: capture((handle) => deps.processForHandle?.(handle) ?? null)
  }
}
