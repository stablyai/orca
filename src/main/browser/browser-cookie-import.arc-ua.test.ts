import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type * as childProcessModule from 'node:child_process'

describe('isAdvertisableChromiumEngineVersion', () => {
  it('accepts real Chromium engine majors and rejects product versions', async () => {
    const { isAdvertisableChromiumEngineVersion } = await import('./browser-session-ua')
    expect(isAdvertisableChromiumEngineVersion('120.0.6099.71')).toBe(true)
    expect(isAdvertisableChromiumEngineVersion('70.0.0.0')).toBe(true)
    expect(isAdvertisableChromiumEngineVersion('1.158.1')).toBe(false)
    expect(isAdvertisableChromiumEngineVersion('1.0.0')).toBe(false)
    expect(isAdvertisableChromiumEngineVersion('not-a-version')).toBe(false)
    // Malformed components with a valid major must not pass (would become Chrome/70.not-a-version).
    expect(isAdvertisableChromiumEngineVersion('70.not-a-version')).toBe(false)
    expect(isAdvertisableChromiumEngineVersion('120.0.invalid.1')).toBe(false)
  })
})

describe('isUnadvertisableChromeUserAgent', () => {
  it('flags stored Chrome/1.x UAs and leaves engine-scale ones alone', async () => {
    const { isUnadvertisableChromeUserAgent } = await import('./browser-session-ua')
    const ua = (version: string): string =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
    expect(isUnadvertisableChromeUserAgent(ua('1.158.1'))).toBe(true)
    expect(isUnadvertisableChromeUserAgent(ua('150.0.7871.47'))).toBe(false)
    expect(isUnadvertisableChromeUserAgent(`${ua('151.0.0.0')} Edg/151.0.0.0`)).toBe(false)
    // Why: non-Chrome UAs (Firefox/Safari imports) carry no engine claim to invalidate.
    expect(isUnadvertisableChromeUserAgent('Mozilla/5.0 (Macintosh) Firefox/126.0')).toBe(false)
  })
})

describe('getUserAgentForBrowser — Arc product version', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    vi.restoreAllMocks()
  })

  it('does not persist Chrome/1.x when Arc reports its product version', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof childProcessModule>('node:child_process')
      return {
        ...actual,
        execFileSync: (cmd: string, args: readonly string[]) => {
          if (cmd === 'defaults' && args[1]?.includes('/Applications/Arc.app/Contents/Info')) {
            return '1.158.1\n'
          }
          return actual.execFileSync(cmd, args as never)
        }
      }
    })

    const { getUserAgentForBrowser } = await import('./browser-cookie-import')
    expect(getUserAgentForBrowser('arc')).toBeNull()
  })

  it('still builds a Chrome-shaped UA when Arc reports an engine-scale version', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof childProcessModule>('node:child_process')
      return {
        ...actual,
        execFileSync: (cmd: string, args: readonly string[]) => {
          if (cmd === 'defaults' && args[1]?.includes('/Applications/Arc.app/Contents/Info')) {
            return '120.0.6099.71\n'
          }
          return actual.execFileSync(cmd, args as never)
        }
      }
    })

    const { getUserAgentForBrowser } = await import('./browser-cookie-import')
    const ua = getUserAgentForBrowser('arc')
    expect(ua).toContain('Chrome/120.0.6099.71')
    expect(ua).not.toContain('Chrome/1.')
  })
})
