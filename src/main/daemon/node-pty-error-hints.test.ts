import { describe, expect, it } from 'vitest'
import { addNodePtyRecoveryHint, parseNodePtyDiagnostic } from './node-pty-error-hints'

describe('node-pty diagnostic error hints', () => {
  it('parses the native step and errno without dropping the original message', () => {
    const message =
      "node-pty: posix_spawn failed: ENOENT (errno 2, No such file or directory) - helper='/tmp/deleted/node-pty/spawn-helper'"

    expect(parseNodePtyDiagnostic(message)).toEqual({ step: 'posix_spawn', errno: 2 })
    expect(addNodePtyRecoveryHint(message)).toBe(
      `Daemon's node-pty install is gone (worktree deleted?). Restart Orca. ${message}`
    )
  })

  it('hints when the daemon exhausts file descriptors opening the slave pty', () => {
    const message =
      "node-pty: open_slave failed: EMFILE (errno 24, Too many open files) - slave='/dev/ttys003'"

    expect(addNodePtyRecoveryHint(message)).toBe(
      `Daemon hit the file-descriptor limit. Restart the daemon. ${message}`
    )
  })

  it('hints when posix_spawn reports the per-user process limit', () => {
    const message =
      "node-pty: posix_spawn failed: EAGAIN (errno 35, Resource temporarily unavailable) - helper='/tmp/node-pty/spawn-helper'"

    expect(addNodePtyRecoveryHint(message)).toBe(
      `Per-user process limit reached. Quit some agents and retry. ${message}`
    )
  })

  it('leaves unrelated and unhinted node-pty diagnostics unchanged', () => {
    expect(addNodePtyRecoveryHint('plain failure')).toBe('plain failure')
    expect(
      addNodePtyRecoveryHint(
        "node-pty: tcsetattr failed: EIO (errno 5, Input/output error) - slave='/dev/ttys003'"
      )
    ).toBe("node-pty: tcsetattr failed: EIO (errno 5, Input/output error) - slave='/dev/ttys003'")
  })
})
