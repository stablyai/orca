import type * as FsModule from 'node:fs'
import type * as RunProcessModule from '../../shared/child-process/run-process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

const PS_START = 'Thu Aug 13 12:34:56 2026'
const PS_STARTED_AT_MS = Date.parse(PS_START)
const PS_IDENTITY_TIMEOUT_MS = 2_000

/** Loss of contact, in both shapes `ps` can produce it: neither is a verdict. */
type PsOutcome = 'ok' | 'timeout' | 'nonzero'

const { runProcessMock, runProcessSyncMock, psCommandLine, psOutcome } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn(),
  psCommandLine: { value: '' },
  psOutcome: { value: 'ok' as PsOutcome }
}))

// Mock the sanctioned child-process layer rather than node:child_process: the
// identity probe runs through runProcess, and runProcessSync must stay uncalled.
vi.mock('../../shared/child-process/run-process', async (importOriginal) => ({
  ...(await importOriginal<typeof RunProcessModule>()),
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
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

function psResult(): RunProcessModule.ProcessResult {
  if (psOutcome.value === 'timeout') {
    return { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }
  }
  if (psOutcome.value === 'nonzero') {
    return { code: 1, signal: null, stdout: '', stderr: 'ps: unavailable', timedOut: false }
  }
  return {
    code: 0,
    signal: null,
    stdout: `${PS_START} ${psCommandLine.value}\n`,
    stderr: '',
    timedOut: false
  }
}

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
    psOutcome.value = 'ok'
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    runProcessMock.mockImplementation(async () => psResult())
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
    expect(runProcessMock).toHaveBeenCalledTimes(1)

    writePidRecord('1.2.3')
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      false
    )
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })

  it('retries an indeterminate bundle-staleness identity inspection', async () => {
    writePidRecord('1.2.2')
    psOutcome.value = 'nonzero'
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      false
    )

    psOutcome.value = 'ok'
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      true
    )
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    expect(runProcessSyncMock).not.toHaveBeenCalled()
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

    expect(runProcessSyncMock).not.toHaveBeenCalled()
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock).toHaveBeenCalledWith({
      program: 'ps',
      args: ['-p', String(process.pid), '-o', 'lstart=', '-o', 'command='],
      timeoutMs: PS_IDENTITY_TIMEOUT_MS
    })

    writePidRecord('1.2.3')
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'intact'
    )
    expect(runProcessMock).toHaveBeenCalledTimes(2)

    rmSync(spawnerExecPath)
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'severed'
    )
    expect(runProcessMock).toHaveBeenCalledTimes(3)
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })

  it('retries an indeterminate identity inspection', async () => {
    writePidRecord('1.2.2')
    psOutcome.value = 'timeout'
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'unknown'
    )

    psOutcome.value = 'ok'
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'intact'
    )

    expect(runProcessSyncMock).not.toHaveBeenCalled()
    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })

  it('fails open for a legacy pid record without app-version metadata', async () => {
    writePidRecord(undefined, false)

    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'unknown'
    )

    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })
})
