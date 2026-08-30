import { beforeEach, describe, expect, it, vi } from 'vitest'

// Regression test for issue #7797: an agent (claude/codex/…) started inside a
// user's tmux window must still be detected as running. Live foreground
// detection walks the process tree DOWNWARD from the pane's shell pid
// (`collectDescendants`). tmux double-forks its server and reparents it to pid
// 1, so the agent is a child of the tmux SERVER, not of the pane shell — the
// downward walk reaches only the tmux CLIENT and used to fall back to `tmux`.
// The fix hops the fork: client → active pane pid via `tmux list-clients`, else
// the reparented server pid from the ps table, then re-runs recognition.

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { resolveAgentForegroundProcess } from './agent-foreground-process'

// Process table for a pane running `tmux` with `claude` inside a tmux window:
//   pid 100 ppid 99  zsh          <- Orca pane shell (root of the foreground walk)
//   pid 101 ppid 100 tmux client  <- what the pane shell actually launched
//   pid 200 ppid 1   tmux server  <- double-forked, reparented to init (pid 1)
//   pid 201 ppid 200 claude       <- the real agent, child of the SERVER
const TMUX_PROCESS_TABLE = [
  '100 99  Ss   -zsh',
  '101 100 S+   tmux',
  '200 1   Ss   tmux',
  '201 200 S+   node /Users/dev/.nvm/versions/node/bin/claude'
].join('\n')

// Why: the modules wrap execFile with promisify, so the mock must honor the
// Node callback contract — the last arg is invoked with (err, {stdout,stderr}).
function reply(cb: unknown, stdout: string): void {
  ;(cb as (err: unknown, result: { stdout: string; stderr: string }) => void)(null, {
    stdout,
    stderr: ''
  })
}

// `ps` always returns the tmux topology. `tmux list-clients` maps the pane's
// client (101) to its active pane pid (201, the claude process) when available,
// or errors (ENOENT) to force the reparented-server fallback.
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

describe('resolveAgentForegroundProcess: agent inside tmux (issue #7797)', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  it('detects claude via the tmux client → active-pane-pid hop', async () => {
    mockProcessTable({ tmuxAvailable: true })
    await expect(resolveAgentForegroundProcess(100, 'tmux')).resolves.toBe('claude')
  })

  it('detects claude via the reparented server pid when tmux is unreachable', async () => {
    mockProcessTable({ tmuxAvailable: false })
    await expect(resolveAgentForegroundProcess(100, 'tmux')).resolves.toBe('claude')
  })

  it('still resolves directly when walking from the tmux server pid (control)', async () => {
    mockProcessTable({ tmuxAvailable: false })
    await expect(resolveAgentForegroundProcess(200, 'tmux')).resolves.toBe('claude')
  })
})
