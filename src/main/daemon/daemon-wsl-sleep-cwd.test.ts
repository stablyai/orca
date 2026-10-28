import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslGuestProcessRow } from '../wsl/wsl-guest-pane-processes'
import type * as GuestProcessesModule from '../wsl/wsl-guest-pane-processes'

const readRows = vi.hoisted(() =>
  vi.fn(async (_distro: string, _timeoutMs: number): Promise<WslGuestProcessRow[] | null> => null)
)
vi.mock('../wsl/wsl-guest-pane-processes', async (importOriginal) => ({
  ...(await importOriginal<typeof GuestProcessesModule>()),
  readWslGuestPaneProcesses: readRows
}))

const { readDaemonWslSleepCwd } = await import('./daemon-wsl-sleep-cwd')

const pane = { paneKey: 'tab-1:leaf-1', wslDistro: 'Ubuntu', live: true }
const shell: WslGuestProcessRow = {
  pid: 10,
  ppid: 1,
  comm: 'bash',
  paneKey: pane.paneKey,
  cwd: '/home/a/deep'
}

describe('readDaemonWslSleepCwd', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    readRows.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it("answers the shell's folder in the bridge's UNC spelling", async () => {
    readRows.mockResolvedValue([shell])
    expect(await readDaemonWslSleepCwd(pane)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\a\\deep')
    // A live pane's distro is running: no separate running check.
    expect(readRows).toHaveBeenCalledWith('Ubuntu', 3_000, { running: true })
  })

  it('gives the read at most a quarter of what is left of the Sleep, capped at 3 s', async () => {
    readRows.mockResolvedValue([shell])
    await readDaemonWslSleepCwd(pane, Date.now() + 4_000)
    expect(readRows.mock.calls[0]?.[1]).toBeLessThanOrEqual(1_000)
    readRows.mockClear()
    expect(await readDaemonWslSleepCwd(pane, Date.now() - 1)).toBeNull()
    expect(readRows).not.toHaveBeenCalled()
  })

  it('gives up at its budget when the distro does not answer', async () => {
    vi.useFakeTimers()
    readRows.mockReturnValue(new Promise(() => {}))
    const read = readDaemonWslSleepCwd(pane)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await read).toBeNull()
  })

  it('reads nothing off Windows', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    expect(await readDaemonWslSleepCwd(pane)).toBeNull()
    expect(readRows).not.toHaveBeenCalled()
  })
})
