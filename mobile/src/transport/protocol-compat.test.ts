import { describe, expect, it } from 'vitest'
import { evaluateCompat } from './protocol-compat'

describe('evaluateCompat', () => {
  it('allows the current mobile app to connect to the ownership-fenced desktop', () => {
    expect(
      evaluateCompat({
        desktopProtocolVersion: 4,
        desktopMinCompatibleMobileVersion: 4
      })
    ).toEqual({ kind: 'ok' })
  })

  it('allows the current mobile app to connect before a protocol-2 desktop updates', () => {
    expect(
      evaluateCompat({
        desktopProtocolVersion: 2,
        desktopMinCompatibleMobileVersion: 2
      })
    ).toEqual({ kind: 'ok' })
  })
})
