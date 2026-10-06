import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../shared/child-process/run-process'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { readMacosBundleId, resetMacosTccPermission } from './macos-tcc-reset'

function processResult(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputTruncated: false,
    ...overrides
  }
}

beforeEach(() => {
  runProcessMock.mockReset()
})

describe('readMacosBundleId', () => {
  it('reads CFBundleIdentifier out of the bundle’s Info.plist', async () => {
    runProcessMock.mockResolvedValue(processResult({ stdout: 'com.stablyai.orca\n' }))

    await expect(readMacosBundleId('/Applications/Orca.app')).resolves.toBe('com.stablyai.orca')
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/libexec/PlistBuddy',
        args: ['-c', 'Print :CFBundleIdentifier', '/Applications/Orca.app/Contents/Info.plist']
      })
    )
  })

  it.each([
    ['a non-zero exit', processResult({ code: 1, stderr: 'Print: Entry, Does Not Exist' })],
    ['empty output', processResult({ stdout: '  \n' })]
  ])('returns null on %s', async (_label, result) => {
    runProcessMock.mockResolvedValue(result)

    await expect(readMacosBundleId('/Applications/Orca.app')).resolves.toBeNull()
  })

  it('returns null rather than throwing when PlistBuddy cannot be started', async () => {
    runProcessMock.mockRejectedValue(new Error('ENOENT'))

    await expect(readMacosBundleId('/Applications/Orca.app')).resolves.toBeNull()
  })
})

describe('resetMacosTccPermission', () => {
  it('clears the service’s row for the bundle id', async () => {
    runProcessMock.mockResolvedValue(processResult({}))

    await expect(
      resetMacosTccPermission('SystemPolicyDocumentsFolder', 'com.stablyai.orca')
    ).resolves.toEqual({ ok: true })
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/bin/tccutil',
        args: ['reset', 'SystemPolicyDocumentsFolder', 'com.stablyai.orca']
      })
    )
  })

  // The observed shape on macOS 15: exit 64, everything on stderr, nothing on stdout.
  it('reports the unknown-bundle-id failure tccutil writes to stderr', async () => {
    runProcessMock.mockResolvedValue(
      processResult({
        code: 64,
        stderr: 'tccutil: No such bundle identifier "com.example.absent"\n'
      })
    )

    await expect(
      resetMacosTccPermission('SystemPolicyDesktopFolder', 'com.example.absent')
    ).resolves.toEqual({
      ok: false,
      detail: 'tccutil: No such bundle identifier "com.example.absent"'
    })
  })

  it.each([
    ['stdout when stderr is empty', processResult({ code: 1, stdout: 'refused\n' }), 'refused'],
    ['the exit code when both are empty', processResult({ code: 70 }), 'exit 70'],
    [
      'an unknown exit when the process was signalled',
      processResult({ code: null }),
      'exit unknown'
    ]
  ])('falls back to %s', async (_label, result, detail) => {
    runProcessMock.mockResolvedValue(result)

    await expect(
      resetMacosTccPermission('SystemPolicyDownloadsFolder', 'com.stablyai.orca')
    ).resolves.toEqual({ ok: false, detail })
  })

  it('reports a failure to start as a failed reset', async () => {
    runProcessMock.mockRejectedValue(new Error('EACCES'))

    await expect(
      resetMacosTccPermission('SystemPolicyDocumentsFolder', 'com.stablyai.orca')
    ).resolves.toEqual({ ok: false, detail: 'EACCES' })
  })
})
