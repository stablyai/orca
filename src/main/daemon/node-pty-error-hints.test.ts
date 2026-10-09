import { describe, expect, it } from 'vitest'
import {
  LEGACY_PTY_ALLOCATION_HINT,
  LEGACY_TERMINAL_PROCESS_LIMIT_HINT,
  PTY_ALLOCATION_HINT,
  TERMINAL_PROCESS_LIMIT_HINT
} from '../../shared/terminal-spawn-error-copy'
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

    expect(addNodePtyRecoveryHint(message)).toBe(`${PTY_ALLOCATION_HINT}\n${message}`)
  })

  it('hints when the system cannot allocate a pty master', () => {
    const message =
      'node-pty: posix_openpt failed: ENFILE (errno 23, Too many open files in system)'

    expect(addNodePtyRecoveryHint(message)).toBe(`${PTY_ALLOCATION_HINT}\n${message}`)
  })

  it('hints when macOS cannot configure a pty master device', () => {
    const message = 'node-pty: posix_openpt failed: errno (errno 6, Device not configured)'

    expect(addNodePtyRecoveryHint(message)).toBe(`${PTY_ALLOCATION_HINT}\n${message}`)
  })

  it('hints local wrapped spawn errors from pty allocation failures', () => {
    const message =
      'Failed to spawn shell "/bin/zsh": node-pty: open_slave failed: EMFILE (errno 24, Too many open files) - slave=\'/dev/ttys003\' (shell: /bin/zsh, cwd: /tmp, arch: arm64, platform: darwin 25.0.0, orca: 1.4.178). If this persists, please file an issue.'

    expect(addNodePtyRecoveryHint(message)).toBe(`${PTY_ALLOCATION_HINT}\n${message}`)
  })

  it('keeps the whole recovery action on the first line', () => {
    const message =
      'Failed to spawn shell "/bin/zsh": node-pty: posix_openpt failed: errno (errno 6, Device not configured) (shell: /bin/zsh). If this persists, please file an issue.'

    expect(addNodePtyRecoveryHint(message).split('\n')[0]).toBe(PTY_ALLOCATION_HINT)
  })

  it('hints unstructured openpty allocation failures', () => {
    const message = 'Failed to spawn shell "/bin/bash": openpty(3) failed.'

    expect(addNodePtyRecoveryHint(message)).toBe(`${PTY_ALLOCATION_HINT}\n${message}`)
  })

  it('hints when posix_spawn reports the per-user process limit', () => {
    const message =
      "node-pty: posix_spawn failed: EAGAIN (errno 35, Resource temporarily unavailable) - helper='/tmp/node-pty/spawn-helper'"

    expect(addNodePtyRecoveryHint(message)).toBe(`${TERMINAL_PROCESS_LIMIT_HINT}\n${message}`)
  })

  it('does not duplicate an existing recovery hint', () => {
    const message =
      "node-pty: open_slave failed: EMFILE (errno 24, Too many open files) - slave='/dev/ttys003'"
    const hinted = `${PTY_ALLOCATION_HINT}\n${message}`

    expect(addNodePtyRecoveryHint(hinted)).toBe(hinted)
  })

  it('does not duplicate hints from an older remote host', () => {
    const ptyError = 'node-pty: open_slave failed: EMFILE (errno 24, Too many open files)'
    const processError = 'node-pty: posix_spawn failed: EAGAIN (errno 35, Resource unavailable)'

    expect(addNodePtyRecoveryHint(`${LEGACY_PTY_ALLOCATION_HINT} ${ptyError}`)).toBe(
      `${LEGACY_PTY_ALLOCATION_HINT} ${ptyError}`
    )
    expect(addNodePtyRecoveryHint(`${LEGACY_TERMINAL_PROCESS_LIMIT_HINT} ${processError}`)).toBe(
      `${LEGACY_TERMINAL_PROCESS_LIMIT_HINT} ${processError}`
    )
  })

  it('does not duplicate a legacy hint on unstructured openpty failures', () => {
    const hinted = `${LEGACY_PTY_ALLOCATION_HINT} Failed to spawn shell "/bin/bash": openpty(3) failed.`

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
