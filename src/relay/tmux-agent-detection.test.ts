import { beforeEach, describe, expect, it, vi } from 'vitest'

// Regression test for issue #7797 — relay/SSH twin. The same tmux double-fork
// blindness affects remote sessions through getForegroundProcessName: an agent
// in a tmux window is a child of the reparented tmux server, not the pane's
// shell subtree, so the downward walk used to report `tmux`. See the daemon-path
// test in src/main/providers/tmux-agent-detection.test.ts for the topology.

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resetProcessTableSnapshotForTests } from '../shared/process-table-snapshot'
import { getForegroundProcessName } from './pty-shell-utils'

//   pid 100 ppid 99  zsh          <- pane shell (root of the foreground walk)
//   pid 101 ppid 100 tmux client  <- what the pane shell actually launched
//   pid 200 ppid 1   tmux server  <- double-forked, reparented to init (pid 1)
//   pid 201 ppid 200 claude       <- the real agent, child of the SERVER
const TMUX_PROCESS_TABLE = [
  '100 99  Ss   -zsh',
  '101 100 S+   tmux',
  '200 1   Ss   tmux',
  '201 200 S+   node /Users/dev/.nvm/versions/node/bin/claude'
].join('\n')

function reply(cb: unknown, stdout: string): void {
  ;(cb as (err: unknown, result: { stdout: string; stderr: string }) => void)(null, {
    stdout,
    stderr: ''
  })
}

function mockProcessTable(options: { tmuxAvailable: boolean }): void {
  execFileMock.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    if (cmd === 'tmux') {
      if (options.tmuxAvailable) {
        reply(cb, '101 201\n')
      } else {
        ;(cb as (err: unknown) => void)(
          Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' })
        )
      }
      return
    }
    reply(cb, TMUX_PROCESS_TABLE)
  })
}

describe('getForegroundProcessName: agent inside tmux over the relay (issue #7797)', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  it('detects claude via the tmux client → active-pane-pid hop', async () => {
    mockProcessTable({ tmuxAvailable: true })
    await expect(getForegroundProcessName(100, 'tmux')).resolves.toBe('claude')
  })

  it('detects claude via the reparented server pid when tmux is unreachable', async () => {
    mockProcessTable({ tmuxAvailable: false })
    await expect(getForegroundProcessName(100, 'tmux')).resolves.toBe('claude')
  })
})
