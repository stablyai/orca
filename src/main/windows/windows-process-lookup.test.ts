import { beforeEach, describe, expect, it, vi } from 'vitest'

const readWindowsProcessTableFresh = vi.fn()

vi.mock('./windows-process-table', () => ({ readWindowsProcessTableFresh }))

const { readWindowsProcess } = await import('./windows-process-lookup')

const DAEMON_ROW = {
  pid: 42,
  ppid: 1,
  name: 'Orca.exe',
  command: 'Orca.exe daemon-entry.js --socket daemon.sock',
  creationTimeMs: 1_790_000_000_000
}

beforeEach(() => {
  readWindowsProcessTableFresh.mockReset()
})

describe('readWindowsProcess', () => {
  it('reads the command line and creation time from a fresh snapshot', async () => {
    readWindowsProcessTableFresh.mockResolvedValue([DAEMON_ROW])

    await expect(readWindowsProcess(42)).resolves.toEqual({
      status: 'present',
      commandLine: DAEMON_ROW.command,
      startedAtMs: DAEMON_ROW.creationTimeMs
    })
  })

  it('reports absence only from a snapshot that ran and lacks the pid', async () => {
    readWindowsProcessTableFresh.mockResolvedValue([DAEMON_ROW])

    await expect(readWindowsProcess(43)).resolves.toEqual({ status: 'missing' })
  })

  it('keeps an unreadable table indeterminate instead of proving the process gone', async () => {
    readWindowsProcessTableFresh.mockRejectedValue(new Error('windows process table is unreadable'))

    await expect(readWindowsProcess(42)).resolves.toEqual({ status: 'unavailable' })
  })

  it('leaves a denied command line and an untimed row as null, not as a mismatch', async () => {
    readWindowsProcessTableFresh.mockResolvedValue([
      { ...DAEMON_ROW, command: '', creationTimeMs: undefined }
    ])

    await expect(readWindowsProcess(42)).resolves.toEqual({
      status: 'present',
      commandLine: null,
      startedAtMs: null
    })
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects unsafe pid %s without reading the table',
    async (pid) => {
      await expect(readWindowsProcess(pid)).resolves.toEqual({ status: 'unavailable' })
      expect(readWindowsProcessTableFresh).not.toHaveBeenCalled()
    }
  )
})
