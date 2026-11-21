import { beforeEach, describe, expect, it, vi } from 'vitest'

const runProcess = vi.fn()
vi.mock('@orca/process-host', () => ({ runProcess: (...args: unknown[]) => runProcess(...args) }))

const { scanDarwin } = await import('./codex-shared-lease-process-scan-darwin')

const isLauncherName = (name: string | undefined): boolean => name === 'orca-provider-e'

function ps(rows: [pid: number, ppid: number, pgid: number, name: string][]): void {
  runProcess.mockResolvedValue({
    code: 0,
    timedOut: false,
    outputTruncated: false,
    stdout: rows.map((row) => row.join(' ')).join('\n')
  })
}

// Orca 10 → launcher leader 100 (own group) → codex 101; watcher 102 leads its own group.
const SERVER: [number, number, number, string][] = [
  [10, 1, 10, 'Electron'],
  [100, 10, 100, 'orca-provider-e'],
  [101, 100, 100, 'codex'],
  [102, 100, 102, 'orca-provider-e']
]

describe('scanDarwin', () => {
  beforeEach(() => runProcess.mockReset())

  it('treats the launcher watcher in its own group as infrastructure', async () => {
    ps(SERVER)
    expect((await scanDarwin(100, isLauncherName))?.unreadable).toEqual([])
  })

  it('reports a launcher-named command Codex started', async () => {
    ps([...SERVER, [103, 101, 103, 'orca-provider-e'], [104, 101, 100, 'sleep']])
    expect((await scanDarwin(100, isLauncherName))?.unreadable.sort()).toEqual([103, 104])
  })
})
