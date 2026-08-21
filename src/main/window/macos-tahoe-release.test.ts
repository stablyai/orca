import { describe, expect, it } from 'vitest'
import { isMacosTahoeOrNewer } from './macos-tahoe-release'

describe('isMacosTahoeOrNewer', () => {
  it('detects Darwin 25+ (macOS 26) as Tahoe or newer', () => {
    expect(isMacosTahoeOrNewer('25.5.0')).toBe(true)
    expect(isMacosTahoeOrNewer('26.0.0')).toBe(true)
  })

  it('treats older Darwin releases as pre-Tahoe', () => {
    expect(isMacosTahoeOrNewer('24.6.0')).toBe(false)
    expect(isMacosTahoeOrNewer('23.0.0')).toBe(false)
  })

  it('treats unparseable releases as pre-Tahoe', () => {
    expect(isMacosTahoeOrNewer('')).toBe(false)
    expect(isMacosTahoeOrNewer('unknown')).toBe(false)
  })
})
