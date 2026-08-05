import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, killMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  killMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

function expectedFallbackFont(platform = process.platform): string {
  if (platform === 'darwin') {
    return 'SF Mono'
  }
  if (platform === 'win32') {
    return 'Cascadia Mono'
  }
  return 'JetBrains Mono'
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  }
}

async function expectFontCommandTimeout(
  platform: NodeJS.Platform,
  timeoutMs: number
): Promise<void> {
  await withPlatform(platform, async () => {
    vi.useFakeTimers()
    execFileMock.mockReturnValue({ kill: killMock })

    const { listSystemFontFamilies } = await import('./system-fonts')
    const fontsPromise = listSystemFontFamilies()
    let resolvedFonts: string[] | null = null
    fontsPromise.then((fonts) => {
      resolvedFonts = fonts
    })

    await vi.advanceTimersByTimeAsync(timeoutMs - 1)

    expect(resolvedFonts).toBeNull()
    expect(killMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    await expect(fontsPromise).resolves.toContain(expectedFallbackFont(platform))
    expect(killMock).toHaveBeenCalledOnce()
  })
}

describe('buildWindowsFontListScript', () => {
  it('forces UTF-8 console output before enumerating font families', async () => {
    const { buildWindowsFontListScript } = await import('./system-fonts')
    const script = buildWindowsFontListScript()
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)')
    expect(script).toContain('InstalledFontCollection')
  })
})

describe('listSystemFontFamilies', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    execFileMock.mockReset()
    killMock.mockReset()
  })

  it('keeps Korean font family names when PowerShell already emits UTF-8', async () => {
    await withPlatform('win32', async () => {
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(null, '굴림\nG마켓 산스 Medium\nConsolas\n')
        return { kill: killMock }
      })
      const { listSystemFontFamilies } = await import('./system-fonts')
      await expect(listSystemFontFamilies()).resolves.toEqual(
        expect.arrayContaining(['굴림', 'G마켓 산스 Medium', 'Consolas'])
      )
      const script = String(execFileMock.mock.calls[0]?.[1]?.at(-1) ?? '')
      expect(script).toContain('UTF8Encoding')
    })
  })

  it('falls back when the platform font command never exits', async () => {
    vi.useFakeTimers()
    execFileMock.mockReturnValue({ kill: killMock })

    const { listSystemFontFamilies } = await import('./system-fonts')
    const fontsPromise = listSystemFontFamilies()
    let resolvedFonts: string[] | null = null
    fontsPromise.then((fonts) => {
      resolvedFonts = fonts
    })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(resolvedFonts).not.toBeNull()
    expect(resolvedFonts).toContain(expectedFallbackFont())
    expect(killMock).toHaveBeenCalledOnce()
  })

  it('uses the longer timeout for macOS profiler scans', async () => {
    await expectFontCommandTimeout('darwin', 45_000)
  })

  it.each([
    ['linux' as NodeJS.Platform, 15_000],
    ['win32' as NodeJS.Platform, 15_000]
  ])('keeps the %s font command timeout short', async (platform, timeoutMs) => {
    await expectFontCommandTimeout(platform, timeoutMs)
  })
})
