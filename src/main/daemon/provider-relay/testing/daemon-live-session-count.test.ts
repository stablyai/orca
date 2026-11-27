import { describe, expect, it } from 'vitest'
import { countLiveDaemonSessions } from '../../protocol/daemon-rpc-contract'
import type { SessionInfo } from '../../protocol/daemon-session-info'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the count reads only isAlive.
const session = (isAlive: boolean) => ({ isAlive }) as SessionInfo

describe('daemon live session count', () => {
  it('counts live relays with live PTYs, so no stop or replace decision ends a running chat', () => {
    const sessions = [session(true), session(false), session(true)]
    expect(countLiveDaemonSessions({ sessions })).toBe(2)
    expect(countLiveDaemonSessions({ sessions, liveRelays: 0 })).toBe(2)
    expect(countLiveDaemonSessions({ sessions: [], liveRelays: 3 })).toBe(3)
    expect(countLiveDaemonSessions({ sessions, liveRelays: 3 })).toBe(5)
    expect(countLiveDaemonSessions({ sessions, liveRelays: -1 })).toBe(2)
  })
})
