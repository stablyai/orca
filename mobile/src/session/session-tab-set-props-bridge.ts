import { sessionTabSetProps } from './mobile-session-write-operations'
import type { RpcResponse } from '../transport/types'

export function requireAcceptedSessionTabProps(response: RpcResponse): {
  publicationEpoch?: string
  snapshotVersion?: number
} {
  const verdict = sessionTabSetProps.interpret(response)
  if (!verdict.accepted) {
    throw new Error('session.tabs.setTabProps was not accepted')
  }
  return verdict.value
}
