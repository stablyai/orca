import { describe, expect, it } from 'vitest'
import {
  PTY_ALLOCATION_HINT,
  TERMINAL_PROCESS_LIMIT_HINT
} from '../../../shared/terminal/pty/lifecycle/terminal-spawn-error-copy'
import { addNodePtyRecoveryHint } from './node-pty-error-hints'

// #40326: at a cgroup pids.max limit a spawn fails with EAGAIN; the user needs the process-limit
// hint, not one about running out of pseudo-terminals.
describe('a terminal spawn refused at a process limit', () => {
  it.each([
    'node-pty: forkpty failed: Resource temporarily unavailable (errno 11)',
    'node-pty: exit_watcher_thread failed: Resource temporarily unavailable (errno 11)',
    'node-pty: exit_watcher_thread failed: thread constructor failed: Resource temporarily unavailable (errno 35)'
  ])('names the process limit for %s', (message) => {
    const hinted = addNodePtyRecoveryHint(message)
    expect(hinted.startsWith(TERMINAL_PROCESS_LIMIT_HINT)).toBe(true)
    expect(hinted.startsWith(PTY_ALLOCATION_HINT)).toBe(false)
    expect(hinted.endsWith(message)).toBe(true)
  })

  it.each([
    'node-pty: forkpty failed: No space left on device (errno 28)',
    'node-pty: forkpty failed: Too many open files (errno 24)'
  ])('still names the pseudo-terminal limit when forkpty ran out of devices: %s', (message) => {
    expect(addNodePtyRecoveryHint(message).startsWith(PTY_ALLOCATION_HINT)).toBe(true)
  })
})
