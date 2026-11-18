import type { ClaudeSession } from '../claude-structured-session-state'

export function claudeHoldsLiveProviderProcess(
  session: ClaudeSession | undefined,
  acquisitionGeneration: string
): boolean {
  return (
    session?.acquisitionGeneration === acquisitionGeneration &&
    session.connection.pid !== undefined &&
    session.connection.exitVerdict.root === 'live'
  )
}
