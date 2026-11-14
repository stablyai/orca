// Exercise generated rcfiles in real interactive bash for both launch-config and wrapper tests.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { expect } from 'vitest'

export function runInteractiveBashRcfile(
  rcfileContent: string,
  tempDir: string,
  inheritedEnv: Record<string, string> = {}
): string {
  const rcfile = join(tempDir, 'bash-osc133-rcfile')
  writeFileSync(rcfile, rcfileContent)

  const result = spawnSync(
    'bash',
    ['-lc', 'bash --noprofile --rcfile "$1" -i 2>&1', 'bash', rcfile],
    {
      input: 'true\nfalse\nexit 0\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        ...inheritedEnv,
        HOME: tempDir,
        ORCA_SHELL_FEATURES: 'ready',
        TERM: process.env.TERM || 'xterm'
      },
      timeout: 5000
    }
  )

  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  return result.stdout
}

export function expectBashOsc133Lifecycle(output: string): void {
  const oscA = '\x1b]133;A\x07'
  const oscC = '\x1b]133;C\x07'
  const oscD = '\x1b]133;D;'
  const firstPromptMarker = output.indexOf(oscA)

  expect(firstPromptMarker).toBeGreaterThanOrEqual(0)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscC)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscD)
  expect(output).toContain(`${oscD}0\x07${oscA}`)
  expect(output).toContain(`${oscD}1\x07${oscA}`)
  expect(output.split(oscC)).toHaveLength(4)
  expect(output.split(oscD)).toHaveLength(3)
}
