import { describe, expect, it, vi } from 'vitest'
import { readStructuredTuiProcessIdentity } from './structured-tui-process-identity'

describe('structured TUI process identity', () => {
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
