import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageJson = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))

describe('Electron runtime package contract', () => {
  it('keeps root postinstall as the single Electron binary install owner', () => {
    expect(packageJson.scripts.postinstall).toBe('node config/scripts/rebuild-native-deps.mjs')
    expect(packageJson.pnpm.onlyBuiltDependencies).not.toContain('electron')
  })

  it('guards package scripts that launch Electron tooling', () => {
    const scripts = packageJson.scripts
    const guardedScripts = [
      'start',
      'dev',
      'dev-stable-name',
      'build:unpack',
      'build:win',
      'build:mac',
      'build:mac:release',
      'build:linux',
      'test:e2e',
      'test:e2e:headful'
    ]

    for (const scriptName of guardedScripts) {
      expect(scripts[scriptName], scriptName).toContain('pnpm run ensure:electron-runtime &&')
    }
  })

  it('guards release publishing before electron-builder runs', () => {
    const releaseWorkflow = readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    const parsedWorkflow = parse(releaseWorkflow)
    const releaseCommands = new Map(
      parsedWorkflow.jobs.build.strategy.matrix.include.map(({ platform, release_command }) => [
        platform,
        release_command
      ])
    )

    expect([...releaseCommands.keys()].sort()).toEqual(['linux', 'mac', 'win'])
    for (const command of releaseCommands.values()) {
      expect(command).toContain('node config/scripts/ensure-native-runtime.mjs --runtime=electron')
      expect(command).toContain('electron-builder')
      expect(command.indexOf('ensure-native-runtime')).toBeLessThan(command.indexOf('electron-builder'))
    }
    expect(releaseCommands.get('mac')).toContain(' && ORCA_MAC_RELEASE=1 ')
    expect(releaseCommands.get('linux')).toContain(' && pnpm exec electron-builder ')
    expect(releaseCommands.get('win')).toContain(
      '; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; pnpm exec electron-builder '
    )
  })
})
