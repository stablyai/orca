import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../shared/child-process/run-process'

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
}))

// Why mock the chokepoint rather than child_process: the timeout, the output
// cap and the hidden console are runProcess's contract now, so this suite
// asserts what font discovery asks for, not how a process gets started.
vi.mock('../shared/child-process/run-process', () => ({
  runProcess: runProcessMock
}))

const ok = (stdout: string): ProcessResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

const timedOut: ProcessResult = {
  code: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  timedOut: true
}

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
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  }
}

describe('listSystemFontFamilies', () => {
  afterEach(() => {
    vi.resetModules()
    runProcessMock.mockReset()
  })

  it('sets UTF-8 stdout encoding as the first statement of the Windows font script', async () => {
    await withPlatform('win32', async () => {
      runProcessMock.mockResolvedValue(ok('Consolas\n'))
      const { listSystemFontFamilies } = await import('./system-fonts')
      await listSystemFontFamilies()

      const args = runProcessMock.mock.calls[0]?.[0].args ?? []
      const script = args[args.indexOf('-Command') + 1] ?? ''
      // Why: match the whole statement, not a substring — anything emitted above it
      // still leaves in the OEM code page, and a swapped encoding must not slip by.
      expect(script.trim().split(/\r?\n/)[0]).toBe(
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'
      )
    })
  })

  it('runs PowerShell by absolute path on Windows', async () => {
    // Why: a bare `powershell.exe` resolves against the child's PATH, which is
    // not the user's under Electron. Where policy has pruned the System32 entry
    // the spawn fails and the picker silently reports five hardcoded families
    // instead of an error (#11771).
    await withPlatform('win32', async () => {
      runProcessMock.mockResolvedValue(ok('Consolas\n'))
      const { listSystemFontFamilies } = await import('./system-fonts')
      await listSystemFontFamilies()

      const program = runProcessMock.mock.calls[0]?.[0].program ?? ''
      expect(program).toMatch(/^[A-Za-z]:[\\/]/)
      expect(program.toLowerCase()).toContain('system32')
      expect(program.toLowerCase()).toContain('powershell.exe')
    })
  })

  it('falls back when the platform font command never exits', async () => {
    runProcessMock.mockResolvedValue(timedOut)

    const { listSystemFontFamilies } = await import('./system-fonts')
    await expect(listSystemFontFamilies()).resolves.toContain(expectedFallbackFont())
  })

  it('falls back when the platform font command reports failure', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'nope',
      timedOut: false
    })

    const { listSystemFontFamilies } = await import('./system-fonts')
    await expect(listSystemFontFamilies()).resolves.toContain(expectedFallbackFont())
  })

  it.each([
    ['darwin' as NodeJS.Platform, 45_000],
    ['linux' as NodeJS.Platform, 15_000],
    ['win32' as NodeJS.Platform, 15_000]
  ])('asks for the %s font command timeout of %dms', async (platform, timeoutMs) => {
    await withPlatform(platform, async () => {
      runProcessMock.mockResolvedValue(ok('Consolas\n'))
      const { listSystemFontFamilies } = await import('./system-fonts')
      await listSystemFontFamilies()

      expect(runProcessMock.mock.calls[0]?.[0].timeoutMs).toBe(timeoutMs)
    })
  })
})
