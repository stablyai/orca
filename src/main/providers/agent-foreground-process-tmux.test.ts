import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
type ExecCallback = (error: unknown, result: { stdout: string; stderr: string }) => void

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { resolveAgentForegroundProcess } from './agent-foreground-process'

describe('agent foreground process through tmux', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
  })

  it('resolves the agent outside the tmux client process tree', async () => {
    execFileMock.mockImplementation(
      (command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        const stdout =
          command === 'ps'
            ? [
                '100 99 Ss   zsh',
                '101 100 S+   tmux attach-session -t work',
                '500 400 Ss   zsh',
                '501 500 S+   claude'
              ].join('\n')
            : '101\t500\tclaude\n'
        callback(null, { stdout, stderr: '' })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'tmux')).resolves.toBe('claude')
  })
})
