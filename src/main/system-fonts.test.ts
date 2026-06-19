import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, killMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  killMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

function expectedFallbackFont(): string {
  if (process.platform === 'darwin') {
    return 'SF Mono'
  }
  if (process.platform === 'win32') {
    return 'Cascadia Mono'
  }
  return 'JetBrains Mono'
}

describe('listSystemFontFamilies', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    execFileMock.mockReset()
    killMock.mockReset()
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
})
