import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateCommitMessageFromContext } from './commit-message-text-generation'
import {
  createChildTerminationExpectation,
  withPlatform
} from './commit-message-text-generation-test-harness'

const { terminateWindowsProcessTreeMock } = vi.hoisted(() => ({
  terminateWindowsProcessTreeMock: vi.fn(async () => {})
}))

vi.mock('../pty/process-retirement/windows-process-tree-kill', () => ({
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

// Fake Windows direct-child/taskkill paths here; source-control-local-process.test.ts covers supervised POSIX stop and managed-home lock release.
const hostPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  vi.unstubAllEnvs()
})

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  // Clear PATH so host agent installs cannot answer fake Windows lookups.
  vi.stubEnv('PATH', '')
  terminateWindowsProcessTreeMock.mockClear()
  terminateWindowsProcessTreeMock.mockResolvedValue(undefined)
  spawnMock.mockClear()
})

describe('generateCommitMessageFromContext on the Windows direct-child path', () => {
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

    await expect(pending).resolves.toMatchObject({
      success: false,
      error:
        'agent CLI command produced too much output. Check the agent CLI configuration and try again.'
    })
    await expectChildTerminated(child)
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

      expect(result).toMatchObject({
        success: false,
        error:
          "C:/tools/agent.cmd runs through a Windows batch script that cannot take the multi-line prompt as an argument. Point Settings at the agent's executable, or use a custom command without {prompt} so Orca sends the prompt on stdin."
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })
})
