import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, killMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  killMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

const WIN32_FALLBACK_FONTS = [
  'Cascadia Mono',
  'Consolas',
  'Lucida Console',
  'JetBrains Mono',
  'Fira Code'
]

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

function mockSpawnSuccess(...lines: string[]): void {
  execFileMock.mockImplementation(
    (_command, _args, _options, callback: (error: Error | null, stdout: string) => void) => {
      callback(null, `${lines.join('\n')}\n`)
    }
  )
}

function mockSpawnError(error: Error): void {
  execFileMock.mockImplementation(
    (_command, _args, _options, callback: (error: Error | null, stdout?: string) => void) => {
      callback(error)
    }
  )
}

async function expectFontCommandTimeout(
  platform: NodeJS.Platform,
  timeoutMs: number,
  expectedKills: number
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
    expect(killMock).toHaveBeenCalledTimes(expectedKills - 1)

    await vi.advanceTimersByTimeAsync(1)

    await expect(fontsPromise).resolves.toContain(expectedFallbackFont(platform))
    expect(killMock).toHaveBeenCalledTimes(expectedKills)
  })
}

describe('listSystemFontFamilies', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    execFileMock.mockReset()
    killMock.mockReset()
  })

  it('sets UTF-8 stdout encoding as the first statement of the Windows font script', async () => {
    await withPlatform('win32', async () => {
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(null, 'Consolas\n')
        return { kill: killMock }
      })
      const { listSystemFontFamilies } = await import('./system-fonts')
      await listSystemFontFamilies()

      const args = (execFileMock.mock.calls[0]?.[1] ?? []) as string[]
      const script = args[args.indexOf('-Command') + 1] ?? ''
      // Why: match the whole statement, not a substring — anything emitted above it
      // still leaves in the OEM code page, and a swapped encoding must not slip by.
      expect(script.trim().split(/\r?\n/)[0]).toBe(
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'
      )
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

    // Windows retries a second PowerShell candidate, so its chain needs 30s;
    // 60s covers every host platform.
    const totalTimeout = process.platform === 'win32' ? 30_000 : 60_000
    await vi.advanceTimersByTimeAsync(totalTimeout)

    expect(resolvedFonts).not.toBeNull()
    expect(resolvedFonts).toContain(expectedFallbackFont())
    expect(killMock).toHaveBeenCalledTimes(process.platform === 'win32' ? 2 : 1)
  })

  it('uses the longer timeout for macOS profiler scans', async () => {
    await expectFontCommandTimeout('darwin', 45_000, 1)
  })

  it.each([
    ['linux' as NodeJS.Platform, 15_000, 1],
    ['win32' as NodeJS.Platform, 30_000, 2]
  ])(
    'falls back when the %s font command times out',
    async (platform, timeoutMs, expectedKills) => {
      await expectFontCommandTimeout(platform, timeoutMs, expectedKills)
    }
  )

  describe('on Windows', () => {
    it('tries pwsh.exe first and stops once it succeeds', async () => {
      await withPlatform('win32', async () => {
        mockSpawnSuccess('Cascadia Mono', 'Consolas')

        const { listSystemFontFamilies } = await import('./system-fonts')
        const fonts = await listSystemFontFamilies()

        expect(execFileMock).toHaveBeenCalledTimes(1)
        expect(execFileMock.mock.calls[0][0]).toBe('pwsh.exe')
        expect(fonts).toEqual(['Cascadia Mono', 'Consolas'])
      })
    })

    it('falls back to the absolute Windows PowerShell path when pwsh is unavailable', async () => {
      await withPlatform('win32', async () => {
        const originalWindir = process.env.WINDIR
        process.env.WINDIR = 'C:\\Windows'
        try {
          execFileMock.mockImplementation(
            (
              command,
              _args,
              _options,
              callback: (error: Error | null, stdout?: string) => void
            ) => {
              if (command === 'pwsh.exe') {
                callback(new Error('spawn pwsh.exe ENOENT'))
                return
              }
              callback(null, 'Cascadia Mono\nConsolas\n')
            }
          )

          const { listSystemFontFamilies } = await import('./system-fonts')
          const fonts = await listSystemFontFamilies()

          expect(execFileMock).toHaveBeenCalledTimes(2)
          expect(execFileMock.mock.calls[0][0]).toBe('pwsh.exe')
          expect(execFileMock.mock.calls[1][0]).toBe(
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
          )
          expect(fonts).toEqual(['Cascadia Mono', 'Consolas'])
        } finally {
          if (originalWindir === undefined) {
            delete process.env.WINDIR
          } else {
            process.env.WINDIR = originalWindir
          }
        }
      })
    })

    it('falls back to hardcoded fonts and logs the real error when every candidate fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await withPlatform('win32', async () => {
          const spawnError = new Error('spawn UNKNOWN (errno -4094)')
          mockSpawnError(spawnError)

          const { listSystemFontFamilies } = await import('./system-fonts')
          const fonts = await listSystemFontFamilies()

          expect(execFileMock).toHaveBeenCalledTimes(2)
          expect(fonts).toEqual(WIN32_FALLBACK_FONTS)
          expect(warnSpy).toHaveBeenCalledTimes(1)
          expect(warnSpy).toHaveBeenCalledWith(
            '[system-fonts] failed to enumerate Windows fonts, using fallback:',
            spawnError
          )
        })
      } finally {
        warnSpy.mockRestore()
      }
    })
  })
})
