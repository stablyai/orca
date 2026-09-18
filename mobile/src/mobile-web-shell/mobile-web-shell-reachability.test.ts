import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

import { readMobileWebShellReachability } from './mobile-web-shell-session'

const CLIENT = {} as unknown as RpcClient

function reachability(state: ConnectionState, client: RpcClient | null = CLIENT): string {
  return readMobileWebShellReachability(state, client)
}

describe('readMobileWebShellReachability', () => {
  it('is connected only with a live client on a connected socket', () => {
    expect(reachability('connected')).toBe('connected')
    expect(reachability('connected', null)).toBe('connecting')
  })

  it('waits through the first dial', () => {
    expect(reachability('connecting')).toBe('connecting')
    expect(reachability('handshaking')).toBe('connecting')
  })

  /**
   * Observed on a simulator with the paired desktop stopped: the client never settles on
   * `disconnected`. It dials, fails, schedules a retry and cycles `connecting` -> `reconnecting`
   * with the delay growing to a minute. Reading `reconnecting` as "still dialling" left a phone
   * holding a verified cached generation spinning on `checking` forever instead of opening it.
   */
  it('treats a scheduled retry as an unreachable host, not as a dial in progress', () => {
    expect(reachability('reconnecting')).toBe('unreachable')
  })

  it('treats a settled non-connection as unreachable', () => {
    expect(reachability('disconnected')).toBe('unreachable')
    expect(reachability('auth-failed')).toBe('unreachable')
  })
})
