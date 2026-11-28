// Every connector call's request and answer, told after it settles: Orca's thread status lines see
// each visible line a bot or Orca posts at this one point, whichever route posted it.
import type { ConnectorResult } from './connector-cloud-request'

export type SentConnectorCall = (
  path: string,
  body: unknown,
  result: ConnectorResult<unknown>
) => void

let installed: SentConnectorCall | null = null

export function installSentConnectorCalls(watch: SentConnectorCall | null): void {
  installed = watch
}

/** Never fails the call it is told of. */
export function noteSentConnectorCall(
  path: string,
  body: unknown,
  result: ConnectorResult<unknown>
): void {
  try {
    installed?.(path, body, result)
  } catch (error) {
    console.warn('[connector] a sent call’s watcher threw', error)
  }
}
