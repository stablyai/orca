import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'
import { runBundledBunFixture } from '../bundled-bun-test-execution'

const SHELLS = ['bash', 'zsh', 'fish'].filter((shell) => {
  if (process.platform === 'win32') {
    return false
  }
  try {
    return runProcessSync({ program: shell, args: ['--version'] }).code === 0
  } catch {
    return false
  }
})
const STARTUP_COMMAND = `bash -c 'read -r line; printf "__STARTUP_INPUT__:%s\\n" "$line"'`

describe('bundled Bun POSIX shell startup-command delivery', () => {
  it.each(SHELLS)(
    '%s runs the command once, forwards stdin, and keeps the shell',
    async (shell) => {
      const home = mkdtempSync(join(tmpdir(), `orca-${shell}-startup-command-`))
      try {
        const output = await runBundledBunFixture(
          join(__dirname, 'shell-startup-command-bun-fixture.ts'),
          'runShellStartupCommandFixture',
          { shell, home },
          10_000
        )
        expect(typeof output).toBe('string')
        if (typeof output !== 'string') {
          throw new Error('Expected terminal transcript')
        }
        expect(output.split(STARTUP_COMMAND)).toHaveLength(2)
        expect(output).toContain('__STARTUP_INPUT__:hello')
        expect(output).toContain('__AFTER_ENV__:missing')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
    15_000
  )
})
