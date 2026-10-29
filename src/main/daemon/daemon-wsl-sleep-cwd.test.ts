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

const { readDaemonWslQuitCwds, readDaemonWslSleepCwd, readDaemonWslSleepCwdWithFacts } =
  await import('./daemon-wsl-sleep-cwd')

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

  it("answers quit's panes within its own budget, leaving out panes it cannot read", async () => {
    readRows.mockResolvedValue([shell])
    const cwds = await readDaemonWslQuitCwds(
      [
        { sessionId: 's1', paneKey: pane.paneKey, wslDistro: 'Ubuntu' },
        { sessionId: 's2', paneKey: 'tab-2:leaf-2', wslDistro: 'Ubuntu' }
      ],
      1_000
    )
    expect(cwds).toEqual(new Map([['s1', '\\\\wsl.localhost\\Ubuntu\\home\\a\\deep']]))
    expect(readRows).toHaveBeenCalledWith('Ubuntu', 1_000, { running: true })
  })

  it('reports how many rows and pane shells the read saw', async () => {
    readRows.mockResolvedValue([shell, { ...shell, pid: 11, cwd: '/home/a' }])
    expect(await readDaemonWslSleepCwdWithFacts(pane)).toEqual({
      cwd: null,
      budgetMs: 3_000,
      rows: 2,
      shells: 2,
      timedOut: false
    })
  })

  it('reports a read that ran out of budget', async () => {
    vi.useFakeTimers()
    readRows.mockReturnValue(new Promise(() => {}))
    const read = readDaemonWslSleepCwdWithFacts(pane)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await read).toMatchObject({ cwd: null, rows: null, shells: null, timedOut: true })
  })

  it('reads nothing off Windows', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    expect(await readDaemonWslSleepCwd(pane)).toBeNull()
    expect(readRows).not.toHaveBeenCalled()
  })
})
