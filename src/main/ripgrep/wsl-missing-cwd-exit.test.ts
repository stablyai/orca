import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'
import { resolveCommand } from '../git/command-runner/wsl-command-resolution'
import {
  isRipgrepMissingCwdExit,
  RIPGREP_MISSING_CWD_EXIT_CODE
} from '../../shared/ripgrep-process-availability'

const execFileAsync = promisify(execFile)

async function shellExitCode(script: string): Promise<number> {
  try {
    await execFileAsync('bash', ['-c', script])
    return 0
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'number') {
      return error.code
    }
    return -1
  }
}

describe('WSL missing-cwd exit code', () => {
  // Why a real shell: the whole point is that `cd x && cmd` collapses into the shell's exit 1,
  // which is also ripgrep's "no matches". Asserting on a mock would not prove the distinction.
  it('is indistinguishable from "no matches" without the guard, and distinct with it', async () => {
    expect(await shellExitCode('cd /definitely/not/here && echo hi')).toBe(1)
    expect(
      await shellExitCode(
        `cd /definitely/not/here || exit ${RIPGREP_MISSING_CWD_EXIT_CODE}; echo hi`
      )
    ).toBe(RIPGREP_MISSING_CWD_EXIT_CODE)
  })

  it('is above the exit codes ripgrep itself uses', () => {
    for (const ripgrepCode of [0, 1, 2]) {
      expect(isRipgrepMissingCwdExit(ripgrepCode)).toBe(false)
    }
    expect(isRipgrepMissingCwdExit(RIPGREP_MISSING_CWD_EXIT_CODE)).toBe(true)
    expect(isRipgrepMissingCwdExit(null)).toBe(false)
  })

  // Why stub the platform: WSL routing is win32-only, so on any other host resolveCommand would
  // return early and the assertions below would silently test nothing.
  it('emits the guard only when asked', () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    onTestFinished(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: original })
    })
    const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    const plain = resolveCommand('rg', ['--files'], cwd, 'Ubuntu')
    const guarded = resolveCommand('rg', ['--files'], cwd, 'Ubuntu', {
      cwdFailureExitCode: RIPGREP_MISSING_CWD_EXIT_CODE
    })

    expect(plain.args.at(-1)).toContain("&& 'rg'")
    expect(guarded.args.at(-1)).toContain(`|| exit ${RIPGREP_MISSING_CWD_EXIT_CODE};`)
    expect(guarded.args.at(-1)).not.toContain("&& 'rg'")
  })
})
