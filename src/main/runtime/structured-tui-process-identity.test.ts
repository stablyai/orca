import { describe, expect, it, vi } from 'vitest'
import {
  readStructuredTuiProcessIdentity,
  resolveStructuredTuiChildPid
} from './structured-tui-process-identity'

describe('structured TUI process identity', () => {
  it('keeps the first row when a process snapshot contains duplicate PIDs', () => {
    const child = {
      pid: 101,
      ppid: 100,
      command: 'codex resume first',
      foreground: true
    }
    const duplicate = { ...child, command: 'codex resume duplicate' }

    expect(
      resolveStructuredTuiChildPid(
        [{ pid: 100, ppid: 1, command: '/bin/zsh', foreground: false }, child, duplicate],
        100,
        'codex'
      )
    ).toBe(101)
  })

  it('indexes process rows once instead of rescanning for every descendant', () => {
    const rowCount = 64
    let pidReads = 0
    const rows = Array.from({ length: rowCount }, (_, index) => {
      const pid = 100 + index
      const row = {
        pid,
        ppid: index === 0 ? 1 : pid - 1,
        command: index === 0 ? '/bin/zsh' : `codex resume ${index}`,
        foreground: index > 0
      }
      Object.defineProperty(row, 'pid', {
        configurable: true,
        get: () => {
          pidReads += 1
          return pid
        }
      })
      return row
    })

    expect(resolveStructuredTuiChildPid(rows, 100, 'codex')).toBe(101)
    // The old per-descendant Array#find path performed quadratic PID reads on this chain.
    expect(pidReads).toBeLessThan(rowCount * 8)
  })

  it('binds the direct Codex child instead of the PTY shell pid', async () => {
    const readStartTime = vi.fn(async () => 1_700_000_000_000)
    await expect(
      readStructuredTuiProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-1',
        agent: 'codex',
        platform: 'darwin',
        readPosixRows: async () => [
          { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
          { pid: 101, ppid: 100, stat: 'S+', command: 'node /opt/codex/bin/codex resume abc' },
          { pid: 102, ppid: 101, stat: 'S+', command: '/opt/codex/vendor/codex' }
        ],
        readStartTime
      })
    ).resolves.toEqual({
      hostId: 'local',
      pid: 101,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: 'spawn-1'
    })
    expect(readStartTime).toHaveBeenCalledWith(101, 'darwin')
  })

  it('fails closed when sibling Codex children make the owner ambiguous', async () => {
    await expect(
      readStructuredTuiProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-1',
        agent: 'codex',
        platform: 'win32',
        readWindowsRows: async () => [
          { pid: 100, ppid: 1, name: 'pwsh.exe', command: 'pwsh.exe', executablePath: '' },
          { pid: 101, ppid: 100, name: 'codex.exe', command: 'codex resume a', executablePath: '' },
          { pid: 102, ppid: 100, name: 'codex.exe', command: 'codex resume b', executablePath: '' }
        ],
        timeoutMs: 0
      })
    ).rejects.toThrow('one exact Codex child process')
  })

  it('waits for a shell-delivered Codex child before binding ownership', async () => {
    let snapshots = 0
    const delays: number[] = []
    await expect(
      readStructuredTuiProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-2',
        agent: 'codex',
        platform: 'darwin',
        readPosixRows: async () => {
          snapshots += 1
          return [
            { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
            ...(snapshots >= 3
              ? [{ pid: 101, ppid: 100, stat: 'S+', command: 'codex resume session-1' }]
              : [])
          ]
        },
        readStartTime: async () => 1_700_000_000_000,
        timeoutMs: 1_000,
        pollIntervalMs: 25,
        now: () => delays.length * 25,
        sleep: async (delayMs) => {
          delays.push(delayMs)
        }
      })
    ).resolves.toEqual({
      hostId: 'local',
      pid: 101,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: 'spawn-2'
    })
    expect(delays).toEqual([25, 25])
  })

  it('fails closed when the process snapshot omitted the PTY root', async () => {
    await expect(
      readStructuredTuiProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-1',
        agent: 'codex',
        platform: 'darwin',
        readPosixRows: async () => [
          { pid: 101, ppid: 100, stat: 'S+', command: 'codex resume abc' }
        ]
      })
    ).rejects.toThrow('root process was not present')
  })
})
