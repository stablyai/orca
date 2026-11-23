import { describe, expect, it, vi } from 'vitest'
vi.mock('../discovery/wsl-background-distro-gate', () => ({
  isWslDistroRunning: vi.fn(),
  wasWslDistroLastSeenRunningSettled: vi.fn()
}))
vi.mock('./wsl-runner', () => ({ runWslProcess: vi.fn() }))

const { parseWslGuestPaneProcesses, readWslGuestPaneShellCwd } =
  await import('./wsl-guest-pane-processes')

const KEY = 'tab-1:leaf-1'
const fenced = (...lines: string[]) =>
  ['ORCA_PANE_PROCESSES_BEGIN', ...lines, 'ORCA_PANE_PROCESSES_END', ''].join('\n')
const row = (pid: number, ppid: number, comm: string, key: string, cwd: string) =>
  [pid, ppid, comm, key, cwd].join('\t')

describe('the guest process table', () => {
  it('reads only between its fences, and nothing from a list that was cut off', () => {
    const stdout = fenced(row(10, 1, 'bash', KEY, '/home/a/deep'))
    expect(parseWslGuestPaneProcesses(`banner\n${stdout}`)).toEqual([
      { pid: 10, ppid: 1, comm: 'bash', paneKey: KEY, cwd: '/home/a/deep' }
    ])
    expect(
      parseWslGuestPaneProcesses(`ORCA_PANE_PROCESSES_BEGIN\n${row(10, 1, 'bash', KEY, '/')}`)
    ).toBeNull()
  })

  it('keeps a folder with a tab in it, and drops one that was deleted', () => {
    const rows = parseWslGuestPaneProcesses(
      fenced(row(10, 1, 'bash', KEY, '/home/a/x\ty'), row(11, 1, 'zsh', 'k2', '/gone (deleted)'))
    )
    expect(rows?.[0]?.cwd).toBe('/home/a/x\ty')
    expect(rows?.[1]?.cwd).toBeUndefined()
  })

  it("answers the pane's topmost shell folder, and nothing when two shells own the pane", () => {
    const rows = parseWslGuestPaneProcesses(
      fenced(
        row(5, 1, 'wsl-relay', KEY, '/'),
        row(10, 5, 'bash', KEY, '/home/a/deep'),
        row(11, 10, 'bash', KEY, '/home/a/sub')
      )
    )
    expect(readWslGuestPaneShellCwd(rows ?? [], KEY)).toBe('/home/a/deep')
    const twoRoots = parseWslGuestPaneProcesses(
      fenced(row(10, 1, 'bash', KEY, '/a'), row(20, 1, 'bash', KEY, '/b'))
    )
    expect(readWslGuestPaneShellCwd(twoRoots ?? [], KEY)).toBeNull()
  })
})
