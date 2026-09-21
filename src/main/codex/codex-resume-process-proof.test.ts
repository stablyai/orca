import { describe, expect, it } from 'vitest'
import {
  isCodexResumeProcessCommandLine,
  readCodexResumeProcessIdentity
} from './codex-resume-process-proof'

const THREAD_ID = '01a03a0d-acbd-74e0-86f2-2615984d3b37'

describe('Codex resume process proof', () => {
  it('binds the exact resumed thread while ignoring a generic Codex sibling', async () => {
    await expect(
      readCodexResumeProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-1',
        threadId: THREAD_ID,
        platform: 'darwin',
        readPosixRows: async () => [
          { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
          {
            pid: 101,
            ppid: 100,
            stat: 'S+',
            command: `node /opt/codex/bin/codex resume ${THREAD_ID}`
          },
          {
            pid: 103,
            ppid: 101,
            stat: 'S+',
            command: `/opt/codex/vendor/codex resume ${THREAD_ID}`
          },
          {
            pid: 102,
            ppid: 100,
            stat: 'S+',
            command: `node /opt/codex/bin/codex --profile work resume ${THREAD_ID}`
          }
        ],
        excludedProcessTreeRootIdentities: [{ pid: 101, processStartTimeMs: null }],
        readStartTime: async () => 1_700_000_000_000,
        timeoutMs: 0
      })
    ).resolves.toMatchObject({ pid: 102 })
  })

  it('rejects the previous owner process tree when no new resume child appears', async () => {
    await expect(
      readCodexResumeProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-1',
        threadId: THREAD_ID,
        platform: 'darwin',
        readPosixRows: async () => [
          { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
          { pid: 101, ppid: 100, stat: 'S+', command: 'node /opt/codex/bin/codex' },
          {
            pid: 102,
            ppid: 101,
            stat: 'S+',
            command: `/opt/codex/vendor/codex resume ${THREAD_ID}`
          }
        ],
        excludedProcessTreeRootIdentities: [{ pid: 101, processStartTimeMs: null }],
        timeoutMs: 0
      })
    ).rejects.toThrow('one exact Codex child process')
  })

  it.each([
    ['another thread', `node /opt/codex/bin/codex resume thread-other`],
    ['a generic Codex child', 'node /opt/codex/bin/codex --profile work']
  ])('rejects %s', async (_case, command) => {
    await expect(
      readCodexResumeProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-1',
        threadId: THREAD_ID,
        platform: 'darwin',
        readPosixRows: async () => [
          { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
          { pid: 101, ppid: 100, stat: 'S+', command }
        ],
        timeoutMs: 0
      })
    ).rejects.toThrow('one exact Codex child process')
  })

  it('accepts an exact resume process after the previous PID was recycled', async () => {
    await expect(
      readCodexResumeProcessIdentity({
        hostId: 'local',
        rootPid: 100,
        spawnToken: 'spawn-1',
        threadId: THREAD_ID,
        platform: 'darwin',
        readPosixRows: async () => [
          { pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' },
          {
            pid: 101,
            ppid: 100,
            stat: 'S+',
            command: `node /opt/codex/bin/codex resume ${THREAD_ID}`
          }
        ],
        excludedProcessTreeRootIdentities: [{ pid: 101, processStartTimeMs: 10 }],
        readStartTime: async () => 5_000,
        timeoutMs: 0
      })
    ).resolves.toMatchObject({ pid: 101 })
  })

  it('parses a quoted Windows executable path with the exact resume argv', () => {
    expect(
      isCodexResumeProcessCommandLine(
        `"C:\\Program Files\\Codex\\codex.exe" --profile work resume ${THREAD_ID}`,
        THREAD_ID,
        'win32'
      )
    ).toBe(true)
  })
})
