import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

/** Tasks route only to their existing provider child; none of these controls starts one. */
export function structuredSessionTaskControlRoutes(
  owner: (id: string) => StructuredAgentSessionAdapter,
  liveOwner: (id: string) => StructuredAgentSessionAdapter | null
) {
  const stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = (
    input
  ) => owner(input.sessionId).stopBackgroundTasks?.(input) ?? Promise.resolve({ cancelled: false })
  const backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']> = (
    id
  ) => liveOwner(id)?.backgroundTaskStops?.(id)
  const foregroundTasks: NonNullable<StructuredAgentSessionAdapter['foregroundTasks']> = (id) =>
    liveOwner(id)?.foregroundTasks?.(id) ?? []
  const backgroundTask: NonNullable<StructuredAgentSessionAdapter['backgroundTask']> = (input) =>
    liveOwner(input.sessionId)?.backgroundTask?.(input) ?? Promise.resolve(false)
  return { stopBackgroundTasks, backgroundTaskStops, foregroundTasks, backgroundTask }
}
