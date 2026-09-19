import { afterEach, describe, expect, it, vi } from 'vitest'

const { isWindowsProcessStartTimeAvailable, readWindowsProcessIdentityTableFresh } = vi.hoisted(
  () => ({
    isWindowsProcessStartTimeAvailable: vi.fn(() => true),
    readWindowsProcessIdentityTableFresh: vi.fn()
  })
)

vi.mock('../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessIdentityTableFresh
}))

const { readProcessStartTimesMs } = await import('./agent-session-process-identity-probe')

const START_TIME = 1_700_000_000_000

afterEach(() => {
  isWindowsProcessStartTimeAvailable.mockReset()
  isWindowsProcessStartTimeAvailable.mockReturnValue(true)
  readWindowsProcessIdentityTableFresh.mockReset()
})

describe('Windows owner identity batch probe', () => {
  it('reads Windows start times for a batch from one process-table snapshot', async () => {
    readWindowsProcessIdentityTableFresh.mockResolvedValue([
      { pid: 4242, ppid: 1, name: 'codex.exe', creationTimeMs: START_TIME },
      { pid: 4243, ppid: 1, name: 'codex.exe', creationTimeMs: START_TIME + 10 }
    ])

    await expect(readProcessStartTimesMs([4242, 4243, 4242], 'win32')).resolves.toEqual(
      new Map([
        [4242, START_TIME],
        [4243, START_TIME + 10]
      ])
    )

    expect(readWindowsProcessIdentityTableFresh).toHaveBeenCalledOnce()
  })
})
