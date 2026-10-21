import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_SHELL_FAILURE_REASONS,
  parseMobileWebShellLoadState
} from '../../modules/orca-mobile-web-shell/src/load-state'

describe('parseMobileWebShellLoadState', () => {
  it('accepts the two states that carry no reason', () => {
    expect(parseMobileWebShellLoadState({ state: 'loading' })).toEqual({ state: 'loading' })
    expect(parseMobileWebShellLoadState({ state: 'ready' })).toEqual({ state: 'ready' })
  })

  it('ignores a reason on a non-failure state', () => {
    expect(parseMobileWebShellLoadState({ state: 'ready', reason: 'render-process-gone' })).toEqual(
      {
        state: 'ready'
      }
    )
  })

  it('accepts every declared failure reason and nothing else', () => {
    for (const reason of MOBILE_WEB_SHELL_FAILURE_REASONS) {
      expect(parseMobileWebShellLoadState({ state: 'failed', reason })).toEqual({
        state: 'failed',
        reason
      })
    }
    expect(parseMobileWebShellLoadState({ state: 'failed', reason: 'boom' })).toBeNull()
    expect(parseMobileWebShellLoadState({ state: 'failed' })).toBeNull()
  })

  // A native layer that learns a fifth state must not be read as one of the four.
  it('rejects an unknown state, a non-string state, and a non-object payload', () => {
    expect(parseMobileWebShellLoadState({ state: 'loaded' })).toBeNull()
    expect(parseMobileWebShellLoadState({ state: 3 })).toBeNull()
    expect(parseMobileWebShellLoadState({})).toBeNull()
    expect(parseMobileWebShellLoadState(null)).toBeNull()
    expect(parseMobileWebShellLoadState('ready')).toBeNull()
    expect(parseMobileWebShellLoadState(undefined)).toBeNull()
  })

  it('does not inherit a reason from the prototype chain', () => {
    const inherited: Record<string, unknown> = Object.create({ reason: 'render-process-gone' })
    inherited.state = 'failed'
    expect(parseMobileWebShellLoadState(inherited)).toBeNull()
  })
})
