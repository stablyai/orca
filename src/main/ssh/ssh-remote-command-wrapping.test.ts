import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { wrapRemoteCommandForPosixShell } from './ssh-connection-utils'

// Why: sshd hands the wrapped command string to the user's login shell with
// `-c`, so running `<shell> -c <wrapped>` locally reproduces the remote parse
// exactly — including the csh/tcsh multiline re-parse failure from #8701.
const LOGIN_SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash', '/bin/csh', '/bin/tcsh']
const availableShells =
  process.platform === 'win32'
    ? []
    : LOGIN_SHELLS.filter((shell) => spawnSync(shell, ['-c', 'exit 0']).status === 0)

function runViaLoginShell(
  loginShell: string,
  wrapped: string,
  input?: string
): { stdout: string; status: number | null } {
  const result = spawnSync(loginShell, ['-c', wrapped], {
    encoding: 'utf8',
    ...(input !== undefined ? { input } : {}),
    timeout: 5000
  })
  expect(result.error).toBeUndefined()
  return { stdout: result.stdout, status: result.status }
}

describe('wrapRemoteCommandForPosixShell', () => {
  it('keeps single-line commands in the plain /bin/sh -c form', () => {
    expect(wrapRemoteCommandForPosixShell('echo "${SHELL:-/bin/sh}"')).toBe(
      `exec /bin/sh -c 'echo "\${SHELL:-/bin/sh}"'`
    )
  })

  it('emits a single-line wrapper for multiline scripts', () => {
    const wrapped = wrapRemoteCommandForPosixShell('echo one\necho two\n')
    expect(wrapped).not.toContain('\n')
    expect(wrapped.startsWith('exec /bin/sh -c ')).toBe(true)
  })

  describe.each(availableShells)('under a %s login shell', (loginShell) => {
    it('runs a multiline script with quotes, backslashes, and expansions intact', () => {
      const script = [
        'echo START',
        `name='it'\\''s %s here'`,
        'for cand in "$HOME" /nonexistent',
        'do',
        '  [ -e "$cand" ] && echo "found: $cand \\\\ $name"',
        'done',
        'echo END'
      ].join('\n')

      const { stdout, status } = runViaLoginShell(
        loginShell,
        wrapRemoteCommandForPosixShell(script)
      )
      expect(status).toBe(0)
      expect(stdout).toContain('START')
      expect(stdout).toContain(`found: ${process.env.HOME} \\ it's %s here`)
      expect(stdout).toContain('END')
    })

    it('propagates the script exit code', () => {
      const { status } = runViaLoginShell(
        loginShell,
        wrapRemoteCommandForPosixShell('echo one\nexit 42\n')
      )
      expect(status).toBe(42)
    })

    it('leaves stdin available to the script', () => {
      const { stdout, status } = runViaLoginShell(
        loginShell,
        wrapRemoteCommandForPosixShell('read line\necho "got: $line"\n'),
        'stream-me\n'
      )
      expect(status).toBe(0)
      expect(stdout).toContain('got: stream-me')
    })
  })
})
