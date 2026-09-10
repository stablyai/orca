import { describe, expect, it } from 'vitest'
import { evaluateCompat, readHostProtocolVerdict } from './protocol-compat'

describe('evaluateCompat', () => {
  it('blocks a retired protocol-2 desktop', () => {
    expect(
      evaluateCompat({
        desktopProtocolVersion: 2,
        desktopMinCompatibleMobileVersion: 2
      })
    ).toEqual({
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion: 2,
      requiredDesktopVersion: 3
    })
  })
})

describe('readHostProtocolVerdict', () => {
  // Why (F7): src/shared/protocol-compat.ts reads an absent field as 0 on purpose, so
  // MIN_COMPATIBLE_DESKTOP_VERSION fences that desktop with an actionable update screen.
  // Reporting it as unreadable would offer a Retry that can never succeed instead.
  it.each([{}, { appVersion: '1.0.0' }, { protocolVersion: null }])(
    'reads absent protocol fields in %j as 0',
    (status) => {
      expect(readHostProtocolVerdict(status)).toEqual({
        kind: 'blocked',
        reason: 'desktop-too-old',
        desktopVersion: 0,
        requiredDesktopVersion: 3
      })
    }
  )

  it.each([
    null,
    [],
    { protocolVersion: '3', minCompatibleMobileVersion: 3 },
    { protocolVersion: 3, minCompatibleMobileVersion: -1 },
    { protocolVersion: 3.5, minCompatibleMobileVersion: 3 }
  ])('leaves a present but unreadable status %j unknown', (status) => {
    expect(readHostProtocolVerdict(status)).toEqual({ kind: 'unknown' })
  })

  it('accepts a compatible desktop', () => {
    expect(readHostProtocolVerdict({ protocolVersion: 3, minCompatibleMobileVersion: 3 })).toEqual({
      kind: 'ok'
    })
  })
})
