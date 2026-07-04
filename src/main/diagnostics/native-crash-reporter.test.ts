import { beforeEach, describe, expect, it, vi } from 'vitest'

const { calls, ensureDirectoryMock, setPathMock, startMock } = vi.hoisted(() => ({
  calls: [] as string[],
  ensureDirectoryMock: vi.fn(() => {
    calls.push('ensure')
    return 'C:\\Users\\example\\AppData\\Local\\Orca\\logs\\diagnostics\\crashpad'
  }),
  setPathMock: vi.fn(() => {
    calls.push('setPath')
  }),
  startMock: vi.fn(() => {
    calls.push('start')
  })
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3',
    setPath: setPathMock
  },
  crashReporter: {
    start: startMock
  }
}))

vi.mock('./native-crash-dump-directory', () => ({
  ensureNativeCrashDumpDirectory: ensureDirectoryMock
}))

vi.mock('../observability/diagnostic-upload-endpoint', () => ({
  resolveDiagnosticOrcaChannel: () => 'dev'
}))

describe('startNativeCrashReporter', () => {
  beforeEach(async () => {
    calls.length = 0
    ensureDirectoryMock.mockClear()
    setPathMock.mockClear()
    startMock.mockClear()
    const reporter = await import('./native-crash-reporter')
    reporter.resetNativeCrashReporterForTest()
  })

  it('sets the crash dump path before starting local-only Crashpad capture', async () => {
    const { startNativeCrashReporter } = await import('./native-crash-reporter')

    const directory = startNativeCrashReporter()

    expect(directory).toBe('C:\\Users\\example\\AppData\\Local\\Orca\\logs\\diagnostics\\crashpad')
    expect(calls).toEqual(['ensure', 'setPath', 'start'])
    expect(setPathMock).toHaveBeenCalledWith('crashDumps', directory)
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadToServer: false,
        ignoreSystemCrashHandler: false,
        globalExtra: expect.objectContaining({
          app_version: '1.2.3',
          orca_channel: 'dev',
          schema_version: '1'
        })
      })
    )
  })

  it('does not start Crashpad twice in one process', async () => {
    const { startNativeCrashReporter } = await import('./native-crash-reporter')

    startNativeCrashReporter()
    const second = startNativeCrashReporter()

    expect(second).toBeNull()
    expect(startMock).toHaveBeenCalledTimes(1)
  })
})
