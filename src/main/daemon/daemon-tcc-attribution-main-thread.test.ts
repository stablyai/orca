import type * as ChildProcessModule from 'node:child_process'
import type * as FsModule from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

const PS_START = 'Thu Aug 13 12:34:56 2026'
const PS_STARTED_AT_MS = Date.parse(PS_START)

const { execFileMock, execFileSyncMock, psCommandLine, psError } = vi.hoisted(() => ({
  execFileMock: vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => callback(psError.value, psError.value ? '' : `${PS_START} ${psCommandLine.value}\n`, '')
  ),
  execFileSyncMock: vi.fn(() => ''),
  psCommandLine: { value: '' },
  psError: { value: null as Error | null }
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  return {
    ...actual,
    readFileSync: ((path, options) => {
      if (String(path) === `/proc/${process.pid}/cmdline`) {
        throw new Error('procfs unavailable on macOS')
      }
      return actual.readFileSync(path, options)
    }) as typeof actual.readFileSync
  }
})

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const { getMacDaemonTccAttributionHealth } = await import('./daemon-tcc-attribution')
const { isDaemonStaleForCurrentBundle } = await import('./daemon-bundle-staleness')

describe('macOS daemon TCC attribution main-thread cost', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let spawnerExecPath: string

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-tcc-main-thread-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
    spawnerExecPath = join(dir, 'Orca')
    writeFileSync(spawnerExecPath, '')
    psCommandLine.value = `node daemon-entry --socket ${socketPath} --token ${tokenPath}`
    psError.value = null
    execFileMock.mockClear()
    execFileSyncMock.mockClear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  afterAll(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  function writePidRecord(appVersion?: string, includeSpawner = true): void {
    writeFileSync(
      join(dir, `daemon-v${PROTOCOL_VERSION}.pid`),
      JSON.stringify({
        pid: process.pid,
        startedAtMs: PS_STARTED_AT_MS,
        launchNonce: 'launch-a',
        ...(appVersion === undefined ? {} : { appVersion }),
        ...(includeSpawner ? { spawnerExecPath } : {})
      })
    )
  }

  it('deduplicates bundle-staleness identity inspection and invalidates by generation', async () => {
    writePidRecord('1.2.2')

    await expect(
      Promise.all([
        isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3'),
        isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')
      ])
    ).resolves.toEqual([true, true])
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      true
    )
    expect(execFileMock).toHaveBeenCalledTimes(1)

    writePidRecord('1.2.3')
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      false
    )
    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('retries an indeterminate bundle-staleness identity inspection', async () => {
    writePidRecord('1.2.2')
    psError.value = new Error('ps unavailable')
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      false
    )

    psError.value = null
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      true
    )
    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('deduplicates identity inspection by daemon generation without a synchronous spawn', async () => {
    writePidRecord('1.2.2')

    await expect(
      Promise.all([
        getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath),
        getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)
      ])
    ).resolves.toEqual(['intact', 'intact'])
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'intact'
    )

    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith(
      'ps',
      ['-p', String(process.pid), '-o', 'lstart=', '-o', 'command='],
      expect.anything(),
      expect.any(Function)
    )

    writePidRecord('1.2.3')
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'intact'
    )
    expect(execFileMock).toHaveBeenCalledTimes(2)

    rmSync(spawnerExecPath)
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'severed'
    )
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })

  it('retries an indeterminate identity inspection', async () => {
    writePidRecord('1.2.2')
    psError.value = new Error('ps unavailable')
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'unknown'
    )

    psError.value = null
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'intact'
    )

    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('fails open for a legacy pid record without app-version metadata', async () => {
    writePidRecord(undefined, false)

    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'unknown'
    )

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })
})
