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

  it('keeps Windows and Linux package builds off the macOS native helper build', () => {
    const scripts = packageJson.scripts

    expect(scripts['build:desktop']).not.toContain('build:computer-macos')
    expect(scripts['build:win']).toContain('pnpm run build:desktop')
    expect(scripts['build:win']).not.toContain('pnpm run build ')
    expect(scripts['build:win']).not.toContain('build:computer-macos')
    expect(scripts['build:linux']).toContain('pnpm run build:desktop')
    expect(scripts['build:linux']).not.toContain('pnpm run build ')
    expect(scripts['build:linux']).not.toContain('build:computer-macos')
    expect(scripts['build:mac']).toContain('pnpm run build:computer-macos')
    expect(scripts['build:release']).toContain('pnpm run build:native')
    expect(scripts['build:release']).not.toContain('build:computer-macos')
  })

  it('guards release publishing before electron-builder runs', () => {
    const releaseWorkflow = readFileSync(
      join(projectDir, '.github/workflows/release-cut.yml'),
      'utf8'
    )
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
      expect(command.indexOf('ensure-native-runtime')).toBeLessThan(
        command.indexOf('electron-builder')
      )
    }
    expect(releaseCommands.get('mac')).toContain(' && ORCA_MAC_RELEASE=1 ')
    expect(releaseCommands.get('linux')).toContain(' && pnpm exec electron-builder ')
    expect(releaseCommands.get('win')).toContain(
      '; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; pnpm exec electron-builder '
    )
  })

  it('lets release-cut tag a version that is already present on main', () => {
    const releaseWorkflow = readFileSync(
      join(projectDir, '.github/workflows/release-cut.yml'),
      'utf8'
    )
    const parsedWorkflow = parse(releaseWorkflow)
    const bumpStep = parsedWorkflow.jobs.cut.steps.find(
      (step) => step.name === 'Bump package.json and tag'
    )

    expect(bumpStep.run).toContain('git diff --cached --quiet')
    expect(bumpStep.run).toContain('git commit --allow-empty -m "$commit_message"')
  })

  it('bumps separate Homebrew casks for stable and RC desktop tags', () => {
    const releaseWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const homebrewWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/homebrew-bump.yml'), 'utf8')
    )

    expect(releaseWorkflow.jobs['homebrew-bump'].if).toContain(
      "startsWith(needs.cut.outputs.tag, 'v')"
    )
    expect(releaseWorkflow.jobs['homebrew-bump'].if).not.toContain('-rc.')
    expect(releaseWorkflow.jobs['homebrew-bump-published-rc-draft'].with.tag).toBe(
      '${{ needs.cut.outputs.latest_published_rc_tag }}'
    )

    const resolveCaskStep = homebrewWorkflow.jobs['bump-cask'].steps.find(
      (step) => step.name === 'Resolve cask target'
    )
    const renderStep = homebrewWorkflow.jobs['bump-cask'].steps.find(
      (step) => step.name === 'Render updated cask file'
    )
    const copyStep = homebrewWorkflow.jobs['bump-cask'].steps.find(
      (step) => step.name === 'Copy cask into tap and open PR'
    )

    expect(resolveCaskStep.run).toContain('token="orca@rc"')
    expect(resolveCaskStep.run).toContain('token="orca"')
    expect(renderStep.env.CASK_PATH).toBe('${{ steps.cask.outputs.path }}')
    expect(copyStep.run).toContain('cp "$CASK_PATH" "tap/$CASK_PATH"')
    expect(copyStep.run).toContain('git add "$CASK_PATH"')
  })

  it('installs the Electron package binary in PR checks without changing native module ABI', () => {
    const prWorkflow = readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8')
    const parsedWorkflow = parse(prWorkflow)
    const installStep = parsedWorkflow.jobs.verify.steps.find(
      (step) => step.name === 'Install Electron package binary for tests'
    )

    expect(installStep.run).toBe('node config/scripts/install-electron-package-binary.mjs')
  })

  it('smokes the packaged CLI from outside the checkout in PR checks', () => {
    const prWorkflow = readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8')
    const parsedWorkflow = parse(prWorkflow)
    const smokeStep = parsedWorkflow.jobs.verify.steps.find(
      (step) => step.name === 'Smoke packaged CLI'
    )

    expect(smokeStep.run).toBe(
      'node config/scripts/smoke-packaged-cli.mjs --app-dir=dist/linux-unpacked'
    )
  })
})
