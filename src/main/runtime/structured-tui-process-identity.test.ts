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
          {
            pid: 101,
            ppid: 100,
            stat: 'S+',
            command: 'node /opt/codex/bin/codex resume abc'
          },
          {
            pid: 102,
            ppid: 101,
            stat: 'S+',
            command: '/opt/codex/vendor/codex'
          }
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
          {
            pid: 100,
            ppid: 1,
            name: 'pwsh.exe',
            command: 'pwsh.exe',
            executablePath: ''
          },
          {
            pid: 101,
            ppid: 100,
            name: 'codex.exe',
            command: 'codex resume a',
            executablePath: ''
          },
          {
            pid: 102,
            ppid: 100,
            name: 'codex.exe',
            command: 'codex resume b',
            executablePath: ''
          }
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
              ? [
                  {
                    pid: 101,
                    ppid: 100,
                    stat: 'S+',
                    command: 'codex resume session-1'
                  }
                ]
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

  // Each poll forks a whole-machine `ps` (~0.065 CPU-s at 1,460 processes), so the
  // capture COUNT per identification is the cost, not the 5s wall ceiling.
  function countCapturesForIdentification(input: {
    captureCostMs: number
    childAppearsAtMs: number | null
  }): Promise<{
    captures: number
    identifiedAtMs: number | null
    elapsedMs: number
  }> {
    let clockMs = 0
    let captures = 0
    return readStructuredTuiProcessIdentity({
      hostId: 'local',
      rootPid: 100,
      spawnToken: 'spawn-cost',
      agent: 'codex',
      platform: 'darwin',
      readPosixRows: async () => {
        captures += 1
        clockMs += input.captureCostMs
        return [
          { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
          ...(input.childAppearsAtMs !== null && clockMs >= input.childAppearsAtMs
            ? [
                {
                  pid: 101,
                  ppid: 100,
                  stat: 'S+',
                  command: 'codex resume session-1'
                }
              ]
            : [])
        ]
      },
      readStartTime: async () => 1_700_000_000_000,
      now: () => clockMs,
      sleep: async (delayMs) => {
        clockMs += delayMs
      }
    }).then(
      () => ({ captures, identifiedAtMs: clockMs, elapsedMs: clockMs }),
      () => ({ captures, identifiedAtMs: null, elapsedMs: clockMs })
    )
  }

  it('does not spend a hundred ps captures on an identification that never resolves', async () => {
    const { captures, identifiedAtMs, elapsedMs } = await countCapturesForIdentification({
      captureCostMs: 55,
      childAppearsAtMs: null
    })

    expect(identifiedAtMs).toBeNull()
    // The 5s ceiling is unchanged; only the captures inside it are.
    expect(elapsedMs).toBeGreaterThanOrEqual(5_000)
    // A flat 50ms poll spends ~48 captures here.
    expect(captures).toBeLessThanOrEqual(20)
  })

  it('keeps identification latency identical while a child can still plausibly appear', async () => {
    // The backoff must not touch the window a real spawn lands in: same capture
    // count and same detection time as the flat 50ms poll.
    for (const childAppearsAtMs of [0, 200, 500, 900]) {
      const flatPollCaptures = Math.max(1, Math.ceil(childAppearsAtMs / (55 + 50)) + 1)
      const { captures, identifiedAtMs } = await countCapturesForIdentification({
        captureCostMs: 55,
        childAppearsAtMs
      })

      expect(identifiedAtMs).not.toBeNull()
      expect(captures).toBeLessThanOrEqual(flatPollCaptures)
      expect(identifiedAtMs!).toBeLessThanOrEqual(childAppearsAtMs + 55 + 50)
    }
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
