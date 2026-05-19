import { describe, expect, it } from 'vitest'
import { addNodePtyRecoveryHint, parseNodePtyDiagnostic } from './node-pty-error-hints'

const PTY_ALLOCATION_HINT = [
  'Your system cannot allocate any more pty devices.',
  '',
  'Orca requires a pty device to launch a new terminal. This error is usually due to having too many terminal windows or terminal sessions open, either in Orca or another program.',
  '',
  'Free up some pty devices and try again.'
].join('\n')

const TERMINAL_PROCESS_LIMIT_HINT = [
  'Your system cannot start another terminal process.',
  '',
  'This is usually due to having too many terminal sessions or other processes running.',
  '',
  'Close unused terminals or quit unused processes and try again.'
].join('\n')

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

    expect(addNodePtyRecoveryHint(message)).toBe(`${PTY_ALLOCATION_HINT} ${message}`)
  })

  it('hints when the system cannot allocate a pty master', () => {
    const message =
      'node-pty: posix_openpt failed: ENFILE (errno 23, Too many open files in system)'

    expect(addNodePtyRecoveryHint(message)).toBe(`${PTY_ALLOCATION_HINT} ${message}`)
  })

  it('hints local wrapped spawn errors from pty allocation failures', () => {
    const message =
      'Failed to spawn shell "/bin/zsh": node-pty: open_slave failed: EMFILE (errno 24, Too many open files) - slave=\'/dev/ttys003\' (shell: /bin/zsh, cwd: /tmp, arch: arm64, platform: darwin 25.0.0). If this persists, please file an issue.'

    expect(addNodePtyRecoveryHint(message)).toBe(`${PTY_ALLOCATION_HINT} ${message}`)
  })

  it('hints unstructured openpty allocation failures', () => {
    const message = 'Failed to spawn shell "/bin/bash": openpty(3) failed.'

    expect(addNodePtyRecoveryHint(message)).toBe(`${PTY_ALLOCATION_HINT} ${message}`)
  })

  it('hints when posix_spawn reports the per-user process limit', () => {
    const message =
      "node-pty: posix_spawn failed: EAGAIN (errno 35, Resource temporarily unavailable) - helper='/tmp/node-pty/spawn-helper'"

    expect(addNodePtyRecoveryHint(message)).toBe(`${TERMINAL_PROCESS_LIMIT_HINT} ${message}`)
  })

  it('does not duplicate an existing recovery hint', () => {
    const message =
      "node-pty: open_slave failed: EMFILE (errno 24, Too many open files) - slave='/dev/ttys003'"
    const hinted = `${PTY_ALLOCATION_HINT} ${message}`

    expect(addNodePtyRecoveryHint(hinted)).toBe(hinted)
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
