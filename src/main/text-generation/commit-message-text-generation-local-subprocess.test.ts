import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateCommitMessageFromContext } from './commit-message-text-generation'
import {
  createChildTerminationExpectation,
  withPlatform
} from './commit-message-text-generation-test-harness'

const { terminateWindowsProcessTreeMock } = vi.hoisted(() => ({
  terminateWindowsProcessTreeMock: vi.fn(async () => {})
}))

vi.mock('../windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: terminateWindowsProcessTreeMock
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn)
  }
})

const spawnMock = vi.mocked(spawn)

const expectChildTerminated = createChildTerminationExpectation(terminateWindowsProcessTreeMock)

beforeEach(() => {
  terminateWindowsProcessTreeMock.mockClear()
  terminateWindowsProcessTreeMock.mockResolvedValue(undefined)
  spawnMock.mockClear()
})

describe('generateCommitMessageFromContext', () => {
  it('caps local agent output before buffering unbounded data', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    listeners.get('stdout:data')?.(Buffer.alloc(4 * 1024 * 1024 + 1))
    listeners.get('close')?.(null)

    await expect(pending).resolves.toEqual({
      success: false,
      error:
        'agent CLI command produced too much output. Check the agent CLI configuration and try again.'
    })
    expectChildTerminated(child)
  })

  it('passes prepared provider environment to local agent subprocesses', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'orca-test-agent-nope'
      },
      {
        kind: 'local',
        cwd: '/repo',
        env: { ...process.env, CODEX_HOME: '/managed/codex-home' }
      }
    )

    listeners.get('stdout:data')?.(Buffer.from('Add README note\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      message: 'Add README note'
    })
    expect(spawnMock).toHaveBeenCalledWith(
      'orca-test-agent-nope',
      [],
      expect.objectContaining({
        env: expect.objectContaining({ CODEX_HOME: '/managed/codex-home' })
      })
    )
  })

  it('routes WSL local commit generation through the selected distro login shell', async () => {
    await withPlatform('win32', async () => {
      process.env.ORCA_HOST_ONLY_SECRET = 'do-not-leak'
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 123,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      spawnMock.mockReturnValue(child as never)

      const pending = generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: '+hello'
        },
        {
          agentId: 'custom',
          model: '',
          customAgentCommand: 'agent --mode fast'
        },
        {
          kind: 'local',
          cwd: 'C:\\repo',
          wslDistro: 'Ubuntu 24.04',
          env: { ...process.env, CODEX_HOME: '/home/tester/.codex' }
        }
      )

      listeners.get('stdout:data')?.(Buffer.from('Update README\n'))
      listeners.get('close')?.(0)

      await expect(pending).resolves.toMatchObject({
        success: true,
        message: 'Update README'
      })
      expect(spawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu 24.04', '--exec', 'sh', '-lc', expect.any(String)],
        expect.objectContaining({
          // Why a concrete directory (#16463): `undefined` makes CreateProcessW inherit
          // Orca's own cwd, a deletable WSL UNC path when it was launched from a
          // worktree. The Linux directory still rides inside the command (/mnt/c/repo,
          // asserted below), so the Windows-side cwd never decides where the agent runs.
          cwd: expect.any(String),
          windowsHide: true,
          env: expect.objectContaining({ CODEX_HOME: '/home/tester/.codex' })
        })
      )
      const spawnEnv = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv
      expect(spawnEnv.ORCA_HOST_ONLY_SECRET).toBeUndefined()
      const shellCommand = spawnMock.mock.calls[0]?.[1]?.[5] as string
      expect(shellCommand).toContain('getent passwd')
      expect(shellCommand).toContain('exec "$_orca_wsl_shell" -ilc')
      expect(shellCommand).toContain('/mnt/c/repo')
      expect(shellCommand).toContain("'agent'")
      expect(shellCommand).toContain('--mode')
      expect(shellCommand).toContain('fast')
    })
  })

  it('routes Windows batch-script agent commands through cmd.exe', async () => {
    const originalComSpec = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    try {
      await withPlatform('win32', async () => {
        const listeners = new Map<string, (value: unknown) => void>()
        const child = {
          pid: 123,
          kill: vi.fn(),
          stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
          stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
          stdin: { end: vi.fn() },
          on: vi.fn((event, callback) => listeners.set(event, callback))
        }
        spawnMock.mockReturnValue(child as never)

        const pending = generateCommitMessageFromContext(
          {
            branch: 'main',
            stagedSummary: 'M\tREADME.md',
            stagedPatch: '+hello'
          },
          {
            agentId: 'custom',
            model: '',
            customAgentCommand: 'C:/tools/agent.cmd'
          },
          {
            kind: 'local',
            cwd: 'C:\\repo'
          }
        )

        listeners.get('stdout:data')?.(Buffer.from('Update README\n'))
        listeners.get('close')?.(0)

        await expect(pending).resolves.toMatchObject({
          success: true,
          message: 'Update README'
        })
        expect(spawnMock).toHaveBeenCalledWith(
          'C:\\Windows\\System32\\cmd.exe',
          ['/d', '/c', 'C:/tools/agent.cmd'],
          expect.objectContaining({
            cwd: 'C:\\repo',
            windowsHide: true
          })
        )
      })
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec
      } else {
        process.env.ComSpec = originalComSpec
      }
    }
  })

  it('rejects unsafe argv prompts for Windows batch-script agent commands', async () => {
    await withPlatform('win32', async () => {
      const result = await generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: '+hello & goodbye'
        },
        {
          agentId: 'custom',
          model: '',
          customAgentCommand: 'C:/tools/agent.cmd {prompt}'
        },
        {
          kind: 'local',
          cwd: 'C:\\repo'
        }
      )

      expect(result).toEqual({
        success: false,
        error:
          'C:/tools/agent.cmd cannot be run as a Windows batch command with the prompt in argv. Remove {prompt} so Orca sends the prompt on stdin.'
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })
})
