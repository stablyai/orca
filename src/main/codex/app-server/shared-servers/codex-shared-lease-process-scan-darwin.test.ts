import { beforeEach, describe, expect, it, vi } from 'vitest'

const runProcess = vi.fn()
vi.mock('@orca/process-host', () => ({ runProcess: (...args: unknown[]) => runProcess(...args) }))

const { scanDarwin } = await import('./codex-shared-lease-process-scan-darwin')

function ps(rows: [pid: number, ppid: number, pgid: number, name: string][]): void {
  runProcess.mockResolvedValue({
    code: 0,
    timedOut: false,
    outputTruncated: false,
    stdout: rows.map((row) => row.join(' ')).join('\n')
  })
}

// Orca 10 → launcher 100 → leader 101 (exec'd into codex, own group) → watcher 102 (own group).
const SERVER: [number, number, number, string][] = [
  [10, 1, 10, 'Electron'],
  [100, 10, 100, 'orca-provider-e'],
  [101, 100, 101, 'codex'],
  [102, 101, 102, 'orca-provider-e']
]

describe('scanDarwin', () => {
  beforeEach(() => runProcess.mockReset())

  it('treats the launcher watcher in its own group as infrastructure', async () => {
    ps(SERVER)
    expect((await scanDarwin(101, 102))?.unreadable).toEqual([])
  })

  it('reports a launcher-named command Codex started', async () => {
    ps([...SERVER, [103, 101, 103, 'orca-provider-e'], [104, 101, 101, 'sleep']])
    expect((await scanDarwin(101, 102))?.unreadable.sort()).toEqual([103, 104])
  })
})
