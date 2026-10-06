import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const packageJson = JSON.parse(readFileSync(resolve(projectDir, 'package.json'), 'utf8'))
const vitestInvocation = /^(?:pnpm exec\s+|npx\s+)?vitest(?:\s|$)/u

function vitestCommands(script) {
  return script
    .split(/\s*&&\s*/u)
    .map((command) => command.trim())
    .filter((command) => vitestInvocation.test(command))
}

describe('direct root Vitest script config contract', () => {
  it('loads an explicit config for every direct root Vitest invocation', () => {
    for (const [name, script] of Object.entries(packageJson.scripts)) {
      for (const command of vitestCommands(script)) {
        expect(command, `${name}: ${command}`).toContain('--config')
      }
    }
  })

  it('keeps the full and focused test commands on the native runtime and project config', () => {
    for (const name of ['test', 'test:one']) {
      const script = packageJson.scripts[name]
      expect(script, `${name}: native runtime guard`).toContain(
        'node config/scripts/ensure-native-runtime.mjs --runtime=node'
      )
      expect(script, `${name}: Vitest config`).toContain(
        'vitest run --config config/vitest.config.ts'
      )
    }
  })
})
