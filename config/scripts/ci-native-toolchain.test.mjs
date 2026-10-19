import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const steps = parse(readFileSync('.github/actions/prepare-native-runtime/action.yml', 'utf8')).runs
  .steps
const toolchain = steps.find((step) => step.name === 'Use external node-gyp')

describe('CI native toolchain preparation', () => {
  // The action's toolchain workaround only runs in Linux Bash.
  it.skipIf(process.platform === 'win32').each([
    ['node', 'true', '0', false],
    ['node', 'true', '1', true],
    ['node', 'false', '0', true],
    ['node', '', '0', true]
  ])('runtime=%s cache=%s probe=%s installs=%s', (runtime, hit, probeStatus, installs) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-ci-native-toolchain-'))
    const log = join(directory, 'commands')
    const environment = join(directory, 'github-env')
    try {
      writeFileSync(log, '')
      writeFileSync(environment, '')
      for (const [name, source] of [
        ['node', 'echo "node $*" >> "$COMMAND_LOG"\nexit "$PROBE_STATUS"'],
        ['npm', 'echo "npm $*" >> "$COMMAND_LOG"\nif [ "$1" = root ]; then echo /global; fi']
      ]) {
        const path = join(directory, name)
        writeFileSync(path, `#!/bin/sh\n${source}\n`)
        chmodSync(path, 0o755)
      }
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', toolchain.run], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          NATIVE_RUNTIME: runtime,
          NATIVE_CACHE_HIT: hit,
          PROBE_STATUS: probeStatus,
          COMMAND_LOG: log,
          GITHUB_ENV: environment
        }
      })
      const commands = readFileSync(log, 'utf8')
      expect(commands.includes('npm install -g node-gyp@11.5.0')).toBe(installs)
      expect(commands.includes('node config/scripts/ensure-native-runtime.mjs --check-only')).toBe(
        runtime === 'node' && hit === 'true'
      )
      expect(readFileSync(environment, 'utf8')).toBe(
        installs ? 'npm_config_node_gyp=/global/node-gyp/bin/node-gyp.js\n' : ''
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
