import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBundledBunFixture } from '../bundled-bun-test-execution'

const SHELLS = process.platform === 'win32' ? [] : ['/bin/bash', '/bin/zsh'].filter(existsSync)
const COMMAND = "printf 'AGENT_%s\\n' STARTED"

async function launch(
  shell: string,
  slow: boolean,
  legacy = false
): Promise<{ output: string; ms: number }> {
  const result = await runBundledBunFixture(
    join(__dirname, 'agent-startup-prompt-bun-fixture.ts'),
    'launchPromptFixture',
    { shell, slow, legacy },
    10_000
  )
  if (
    typeof result !== 'object' ||
    result === null ||
    !('output' in result) ||
    typeof result.output !== 'string' ||
    !('ms' in result) ||
    typeof result.ms !== 'number'
  ) {
    throw new Error('Invalid prompt fixture result')
  }
  return { output: result.output, ms: result.ms }
}

describe('agent startup at the rendered shell prompt', () => {
  it.each(SHELLS)(
    '%s displays the command once after slow startup and prompt expansion',
    async (shell) => {
      const before = await launch(shell, true, true)
      expect(before.output.split(COMMAND)).toHaveLength(3)
      const result = await launch(shell, true)
      expect(result.output).not.toContain('orca-shell-ready')
      expect(result.output.split(COMMAND)).toHaveLength(2)
      expect(result.output.indexOf('prompt> ')).toBeLessThan(result.output.indexOf(COMMAND))
    }
  )

  it.skipIf(!process.env.ORCA_STARTUP_BENCH || SHELLS.length === 0)(
    'compares legacy input timing with prompt delivery',
    async () => {
      for (const shell of SHELLS) {
        for (const slow of [false, true]) {
          const legacy: number[] = []
          const current: number[] = []
          for (let i = 0; i < 5; i++) {
            legacy.push((await launch(shell, slow, true)).ms)
            const result = await launch(shell, slow)
            expect(result.output).not.toContain('orca-shell-ready')
            expect(result.output.split(COMMAND)).toHaveLength(2)
            current.push(result.ms)
          }
          const result = JSON.stringify({ shell, slow, legacy, current })
          if (process.env.ORCA_STARTUP_BENCH_OUTPUT) {
            appendFileSync(process.env.ORCA_STARTUP_BENCH_OUTPUT, `${result}\n`)
          }
          console.log(result)
        }
      }
    },
    60_000
  )
})
