import { describe, expect, it } from 'vitest'
import {
  AgentSessionResumeClaims,
  type AgentSessionResumeClaim
} from './agent-session-resume-claims'

const SESSION = { agent: 'claude', providerSession: { key: 'session_id', id: 'one' } } as const

function makeClaims(reported = () => false) {
  const exits = new Map<string, () => void>()
  const claims = new AgentSessionResumeClaims({
    reported,
    watchExit: (ptyId, onExit) => {
      exits.set(ptyId, onExit)
      return () => exits.delete(ptyId)
    }
  })
  return { claims, exits }
}

describe('AgentSessionResumeClaims', () => {
  it('refuses another pane while one is unsettled', () => {
    const { claims } = makeClaims()
    expect(claims.claim(SESSION, 'tab:a')).not.toBeNull()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    expect(
      claims.claim({ ...SESSION, providerSession: { key: 'session_id', id: 'two' } }, 'tab:b')
    ).not.toBeNull()
  })

  it('shares one pane between overlapping opens until every open fails before dispatch', () => {
    const { claims } = makeClaims()
    const first = claims.claim(SESSION, 'tab:a')
    const second = claims.claim(SESSION, 'tab:a')
    first?.settleFailure(false)
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    second?.settleFailure(false)
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('keeps a lost-reply attempt held unless a retry of the same request binds', () => {
    const { claims, exits } = makeClaims()
    claims.claim(SESSION, 'tab:a', 'request-1')?.settleFailure(true, new Error('reply lost'))
    // Proof that this share dispatched no agent cannot account for the earlier lost reply.
    claims.claim(SESSION, 'tab:a', 'request-1')?.settleFailure(false)
    expect(exits.has('plain-shell')).toBe(false)
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    // Another request's spawn accounts only for itself.
    claims.claim(SESSION, 'tab:a', 'request-2')?.bind('pty-2')
    exits.get('pty-2')?.()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()

    claims.claim(SESSION, 'tab:a', 'request-1')?.bind('pty-1')
    exits.get('pty-1')?.()
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('keeps a dispatched spawn with no identified PTY held', () => {
    const { claims } = makeClaims()
    claims.claim(SESSION, 'tab:a')?.settleFailure(true, new Error('spawn reply lost'))
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
  })

  it('releases a dispatched spawn that proved its exit during start', () => {
    const { claims } = makeClaims()
    claims
      .claim(SESSION, 'tab:a')
      ?.settleFailure(true, new Error('agent_session_exited_during_start'))
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('ends a bound hold when its exact PTY exits, even if the create then failed', () => {
    const { claims, exits } = makeClaims()
    const claim = claims.claim(SESSION, 'tab:a')
    claim?.bind('pty-1')
    claim?.settleFailure(true, new Error('publication failed'))
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()

    exits.get('pty-1')?.()
    expect(exits.has('pty-1')).toBe(false)
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('keeps a hold until every PTY its overlapping opens bound has exited', () => {
    const { claims, exits } = makeClaims()
    const first = claims.claim(SESSION, 'tab:a')
    const second = claims.claim(SESSION, 'tab:a')
    first?.bind('pty-1')
    second?.bind('pty-2')

    exits.get('pty-2')?.()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    exits.get('pty-1')?.()
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('keeps a hold while an overlapping open is still spawning', () => {
    const { claims, exits } = makeClaims()
    claims.claim(SESSION, 'tab:a')?.bind('pty-1')
    claims.claim(SESSION, 'tab:a')

    exits.get('pty-1')?.()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
  })

  it.each(['pending', 'bound', 'lost reply'])(
    'keeps overlapping %s opens held during lazy report checks',
    (state) => {
      let reported = false
      const { claims } = makeClaims(() => reported)
      claims.claim(SESSION, 'tab:a')?.bind('pty-1')
      const second = claims.claim(SESSION, 'tab:a', 'second')
      if (state === 'bound') {
        second?.bind('pty-2')
      }
      if (state === 'lost reply') {
        second?.settleFailure(true, new Error('reply lost'))
      }
      reported = true
      expect(claims.claim(SESSION, 'tab:b')).toBeNull()
      reported = false
      expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    }
  )

  it('ends a hold once the hook store reports it in its pane', () => {
    let reported = false
    const { claims, exits } = makeClaims(() => reported)
    claims.claim(SESSION, 'tab:a')?.bind('pty-1')
    reported = true
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
    expect(exits.has('pty-1')).toBe(false)
  })

  function makeReportedClaims() {
    const state = { reported: false }
    const listeners = new Set<() => void>()
    const exits = new Map<string, () => void>()
    const claims = new AgentSessionResumeClaims({
      reported: () => state.reported,
      watchExit: (ptyId, onExit) => {
        exits.set(ptyId, onExit)
        return () => exits.delete(ptyId)
      },
      watchReports: (onChange) => {
        listeners.add(onChange)
        return () => listeners.delete(onChange)
      }
    })
    const report = (): void => {
      state.reported = true
      listeners.forEach((onChange) => onChange())
      // The reporting agent exits to its shell: its row is gone, its PTY stays.
      state.reported = false
    }
    return { claims, listeners, exits, report }
  }

  it.each([
    ['a second open has not spawned yet', (second: AgentSessionResumeClaim | null) => second],
    [
      'a second open spawned its own PTY',
      (second: AgentSessionResumeClaim | null) => {
        second?.bind('pty-2')
        return null
      }
    ]
  ])('keeps a same-pane hold through one report while %s', (_case, settleSecond) => {
    const { claims, report } = makeReportedClaims()
    claims.claim(SESSION, 'tab:a')?.bind('pty-1')
    settleSecond(claims.claim(SESSION, 'tab:a'))
    report()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
  })

  it('ends a hold once the hook store reports it, even if the row is gone by the next claim', () => {
    const { claims, listeners, exits, report } = makeReportedClaims()
    claims.claim(SESSION, 'tab:a')?.bind('pty-1')
    expect(listeners.size).toBe(1)
    report()
    expect(listeners.size).toBe(0)
    expect(exits.has('pty-1')).toBe(false)
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })
})
