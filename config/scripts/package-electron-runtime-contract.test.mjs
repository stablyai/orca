import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')
const packageJson = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))

describe('Electron runtime package contract', () => {
  it('keeps shared WebGL atlas invalidation reproducible from vendored source', () => {
    const patch = readFileSync(
      join(projectDir, 'config/patches/@xterm__addon-webgl@0.20.0-beta.286.patch'),
      'utf8'
    )

    expect(patch).toContain('diff --git a/src/Types.ts b/src/Types.ts')
    expect(patch).toContain('readonly clearModelGeneration: number')
    expect(patch).toContain('const generation = this._atlas.clearModelGeneration')
    expect(patch).toContain('this.clearModelGeneration++')
    expect(patch).toContain('this._atlas._clearModelGeneration||0')
  })

  it('keeps root postinstall as the single Electron binary install owner', () => {
    expect(packageJson.scripts.postinstall).toBe('node config/scripts/rebuild-native-deps.mjs')
    expect(packageJson.pnpm.onlyBuiltDependencies).not.toContain('electron')
  })

  it('keeps the native Windows registry addon optional and platform-gated', () => {
    const rebuildScript = readFileSync(
      join(projectDir, 'config/scripts/rebuild-native-deps.mjs'),
      'utf8'
    )
    const ensureScript = readFileSync(
      join(projectDir, 'config/scripts/ensure-native-runtime.mjs'),
      'utf8'
    )
    expect(packageJson.optionalDependencies['windows-native-registry']).toBe('3.2.2')
    // Why: pnpm installs optional target architectures on every host; the root
    // Windows-only rebuild owns this addon so macOS/Linux never run node-gyp for it.
    expect(packageJson.pnpm.onlyBuiltDependencies).not.toContain('windows-native-registry')
    expect(rebuildScript).toContain(
      "rebuildPlatform === 'win32' ? ['windows-native-registry'] : []"
    )
    expect(ensureScript).toContain(
      "process.platform === 'win32' ? ['windows-native-registry'] : []"
    )
    const packageTargets = {
      win32: createPackagedRuntimeNodeModuleResources('win32'),
      darwin: createPackagedRuntimeNodeModuleResources('darwin'),
      linux: createPackagedRuntimeNodeModuleResources('linux')
    }
    expect(packageTargets.win32).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: join('node_modules', 'windows-native-registry') }),
        expect.objectContaining({ to: join('node_modules', 'node-addon-api') })
      ])
    )
    for (const platform of ['darwin', 'linux']) {
      expect(packageTargets[platform]).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: join('node_modules', 'windows-native-registry') })
        ])
      )
    }
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
      'test:e2e:freeze-safety',
      'test:e2e:terminal-rendering-golden',
      'test:e2e:terminal-rendering-release-evidence',
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

  it('runs the web build through the heap-sized Vite wrapper', () => {
    expect(packageJson.scripts['build:web']).toContain('node config/scripts/run-vite-web-build.mjs')
    expect(packageJson.scripts['build:web']).toContain('node config/scripts/verify-web-build.mjs')
  })

  it('guards release publishing before electron-builder runs', () => {
    const releaseWorkflow = readFileSync(
      join(projectDir, '.github/workflows/release-cut.yml'),
      'utf8'
    )
    const parsedWorkflow = parse(releaseWorkflow)
    const macWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-mac-build.yml'), 'utf8')
    )
    const releaseCommands = new Map(
      parsedWorkflow.jobs.build.strategy.matrix.include.map(({ platform, release_command }) => [
        platform,
        release_command
      ])
    )
    const macReleaseCommand = macWorkflow.jobs['build-mac'].steps.find(
      (step) => step.name === 'Publish release artifacts (macOS)'
    ).with.command

    expect([...releaseCommands.keys()].sort()).toEqual(['linux-arm64', 'linux-x64', 'win'])
    for (const command of [...releaseCommands.values(), macReleaseCommand]) {
      expect(command).toContain('node config/scripts/ensure-native-runtime.mjs --runtime=electron')
      expect(command).toContain('electron-builder')
      expect(command.indexOf('ensure-native-runtime')).toBeLessThan(
        command.indexOf('electron-builder')
      )
    }
    expect(macReleaseCommand).toContain(' && ORCA_MAC_RELEASE=1 ')
    expect(releaseCommands.get('linux-x64')).toContain(' && pnpm exec electron-builder ')
    expect(releaseCommands.get('linux-x64')).toContain('--linux AppImage deb rpm --x64')
    expect(releaseCommands.get('linux-arm64')).toContain('ORCA_LINUX_ARM64_RELEASE=1')
    expect(releaseCommands.get('linux-arm64')).toContain('--linux AppImage deb rpm --arm64')
    expect(releaseCommands.get('win')).toContain(
      '; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; pnpm exec electron-builder '
    )
  })

  it('blocks Linux and macOS release packaging on watcher process fault recovery', () => {
    const releaseWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const macWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-mac-build.yml'), 'utf8')
    )
    const assertFaultGate = (steps, publishStepName, expectedCondition) => {
      const names = steps.map((step) => step.name)
      const gate = steps.find((step) => step.name === 'Gate runtime file-watcher process isolation')

      expect(gate.if).toBe(expectedCondition)
      expect(gate['continue-on-error']).toBeUndefined()
      expect(gate.run).toContain('node config/scripts/runtime-file-watcher-fault-harness.mjs')
      expect(gate.run).toContain('ELECTRON_RUN_AS_NODE=1 pnpm exec electron')
      expect(names.indexOf('Build app')).toBeLessThan(names.indexOf(gate.name))
      expect(names.indexOf(gate.name)).toBeLessThan(names.indexOf(publishStepName))
    }

    assertFaultGate(
      releaseWorkflow.jobs.build.steps,
      'Publish release artifacts (Linux)',
      "runner.os == 'Linux'"
    )
    assertFaultGate(
      macWorkflow.jobs['build-mac'].steps,
      'Publish release artifacts (macOS)',
      undefined
    )
  })

  it('packages and release-gates the SSH relay watcher child', () => {
    const relayBuild = readFileSync(join(projectDir, 'config/scripts/build-relay.mjs'), 'utf8')
    const builderConfig = readFileSync(
      join(projectDir, 'config/electron-builder.config.cjs'),
      'utf8'
    )
    const remoteCommands = readFileSync(
      join(projectDir, 'src/main/ssh/ssh-remote-commands.ts'),
      'utf8'
    )
    const releaseWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const macWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-mac-build.yml'), 'utf8')
    )

    expect(relayBuild).toContain("'parcel-watcher-process-entry.ts'")
    expect(relayBuild).toContain("outfile: join(outDir, 'relay-watcher.js')")
    expect(relayBuild).toContain("readFileSync(join(outDir, 'relay-watcher.js'))")
    expect(builderConfig).toContain("from: 'out/relay'")
    expect(remoteCommands).toContain("joinRemotePath(host, remoteRelayDir, 'relay-watcher.js')")

    const assertRelayGate = (steps, publishStepName) => {
      const names = steps.map((step) => step.name)
      const gate = steps.find((step) => step.name === 'Gate SSH relay watcher process isolation')
      expect(gate['continue-on-error']).toBeUndefined()
      expect(gate.run).toContain('node config/scripts/relay-watcher-fault-harness.mjs')
      expect(names.indexOf('Build app')).toBeLessThan(names.indexOf(gate.name))
      expect(names.indexOf(gate.name)).toBeLessThan(names.indexOf(publishStepName))
    }

    assertRelayGate(releaseWorkflow.jobs.build.steps, 'Publish release artifacts (Linux)')
    assertRelayGate(macWorkflow.jobs['build-mac'].steps, 'Publish release artifacts (macOS)')
    const releaseNames = releaseWorkflow.jobs.build.steps.map((step) => step.name)
    expect(releaseNames.indexOf('Gate SSH relay watcher process isolation')).toBeLessThan(
      releaseNames.indexOf('Build Windows release artifacts')
    )
  })

  it('packages and verifies the Windows SSH node-pty console-list fallback', () => {
    const relayBuild = readFileSync(join(projectDir, 'config/scripts/build-relay.mjs'), 'utf8')
    const relayDeploy = readFileSync(join(projectDir, 'src/main/ssh/ssh-relay-deploy.ts'), 'utf8')
    const patchAsset = readFileSync(
      join(projectDir, 'config/relay-assets/node-pty-1.1.0-console-list-agent-patch.cjs'),
      'utf8'
    )

    expect(relayBuild).toContain('copyFileSync(')
    expect(relayBuild).toContain('hash.update(readFileSync')
    expect(relayBuild).toContain('node-pty-1.1.0-console-list-agent-patch.cjs')
    expect(relayDeploy).toContain('assertPatchedNodePtyConsoleListAgent')
    expect(relayDeploy.match(/\$\{windowsNodePtyPatchCommand\(nodePath\)\}/g)).toHaveLength(2)
    expect(patchAsset).toContain('consoleProcessList = [shellPid];')
    expect(patchAsset).toContain('packageJson.version !== EXPECTED_NODE_PTY_VERSION')
  })

  it('pins the Windows release builder to the VS 2022 runner image', () => {
    const releaseWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const windowsReleaseEntry = releaseWorkflow.jobs.build.strategy.matrix.include.find(
      ({ platform }) => platform === 'win'
    )

    expect(windowsReleaseEntry.os).toBe('windows-2022')
  })

  it('keeps release-cut signing provenance on GitHub-hosted runners', () => {
    const releaseWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const buildMatrixRunners = releaseWorkflow.jobs.build.strategy.matrix.include.map(
      ({ os }) => os
    )
    const releaseWorkflowText = readFileSync(
      join(projectDir, '.github/workflows/release-cut.yml'),
      'utf8'
    )
    const macDispatchStep = releaseWorkflow.jobs['build-mac'].steps.find(
      (step) => step.name === 'Run isolated macOS release build'
    )

    expect(releaseWorkflowText).not.toContain('blacksmith-')
    expect(releaseWorkflow.jobs['build-mac']['runs-on']).toBe('ubuntu-latest')
    expect(releaseWorkflow.jobs['build-mac'].permissions.actions).toBe('write')
    expect(macDispatchStep.run).toBe('node config/scripts/run-release-mac-build-workflow.mjs')
    expect(macDispatchStep.env.RELEASE_MAC_BUILD_WORKFLOW).toBe('release-mac-build.yml')
    expect(macDispatchStep.env.RELEASE_MAC_BUILD_TAG).toBe('${{ needs.cut.outputs.tag }}')
    expect(buildMatrixRunners).not.toContain('blacksmith-6vcpu-macos-15')
    expect(releaseWorkflow.jobs['publish-release'].needs).toContain('build')
    expect(releaseWorkflow.jobs['publish-release'].needs).toContain('build-mac')
  })

  it('runs the macOS release build in an isolated Blacksmith workflow', () => {
    const releaseMacWorkflowText = readFileSync(
      join(projectDir, '.github/workflows/release-mac-build.yml'),
      'utf8'
    )
    const releaseMacWorkflow = parse(releaseMacWorkflowText)
    const buildMacJob = releaseMacWorkflow.jobs['build-mac']
    const checkoutStep = buildMacJob.steps.find((step) => step.name === 'Checkout')
    const publishStep = buildMacJob.steps.find(
      (step) => step.name === 'Publish release artifacts (macOS)'
    )

    expect(releaseMacWorkflow['run-name']).toBe(
      'Mac release build ${{ inputs.tag }} (${{ inputs.release_run_id }})'
    )
    expect(releaseMacWorkflow.on.workflow_dispatch.inputs.tag.required).toBe(true)
    expect(releaseMacWorkflow.on.workflow_dispatch.inputs.release_run_id.required).toBe(true)
    expect(buildMacJob['runs-on']).toBe('blacksmith-6vcpu-macos-15')
    expect(checkoutStep.with.ref).toBe('refs/tags/${{ inputs.tag }}')
    expect(publishStep.with.command).toContain('ORCA_MAC_RELEASE=1')
    expect(publishStep.with.command).toContain('electron-builder')
    expect(publishStep.with.command).toContain('--mac --publish always')
    expect(releaseMacWorkflowText).not.toContain('signpath/')
    expect(releaseMacWorkflowText).not.toContain('SIGNPATH_')
  })

  it('publishes both Linux release matrix entries', () => {
    const releaseWorkflow = readFileSync(
      join(projectDir, '.github/workflows/release-cut.yml'),
      'utf8'
    )
    const parsedWorkflow = parse(releaseWorkflow)
    const publishLinuxStep = parsedWorkflow.jobs.build.steps.find(
      (step) => step.name === 'Publish release artifacts (Linux)'
    )

    expect(publishLinuxStep.if).toContain("matrix.platform == 'linux-x64'")
    expect(publishLinuxStep.if).toContain("matrix.platform == 'linux-arm64'")
    expect(publishLinuxStep.with.command).toBe('${{ matrix.release_command }}')
  })

  it('keeps Linux postinstall repairing Chromium sandbox permissions', () => {
    const afterInstallScript = readFileSync(
      join(projectDir, 'resources/linux/packaging/after-install.sh'),
      'utf8'
    )

    expect(afterInstallScript).toContain('chrome-sandbox')
    expect(afterInstallScript).toContain('chmod 4755 "$sandbox"')
    expect(afterInstallScript).not.toContain('chmod 0755 "$sandbox"')
  })

  it('advances only the skill release ledger in a taggable release-cut commit', () => {
    const releaseWorkflow = readFileSync(
      join(projectDir, '.github/workflows/release-cut.yml'),
      'utf8'
    )
    const parsedWorkflow = parse(releaseWorkflow)
    const checkoutStep = parsedWorkflow.jobs.cut.steps.find((step) => step.name === 'Checkout ref')
    const bumpStep = parsedWorkflow.jobs.cut.steps.find(
      (step) => step.name === 'Bump package.json and tag'
    )

    const bumpIndex = bumpStep.run.indexOf(
      'npm version "$VERSION" --no-git-tag-version --allow-same-version'
    )
    const generateIndex = bumpStep.run.indexOf(
      'node config/scripts/generate-skill-bundle-manifest.mjs --release "$VERSION"'
    )
    const commands = bumpStep.run.replace(/^\s*#.*$/gm, '')
    // Unanchored: a `git add` chained after `&&` stages just as effectively.
    const stagedPaths = [...commands.matchAll(/\bgit add (.+)$/gm)].flatMap((match) =>
      match[1].trim().split(/\s+/)
    )
    // Quotes trimmed and deduped: the index guard names the row a second time.
    const mentioned = new Set(commands.match(/resources[/\\]skills[^\s'"]*/g))
    expect(checkoutStep.with['fetch-depth']).toBe(0)
    expect(bumpIndex).toBeGreaterThanOrEqual(0)
    // Why: the cut is the only point that advances the release ledger, so this
    // tag's revision is never rebuilt later — it appends that row, nothing else.
    expect(generateIndex).toBeGreaterThan(bumpIndex)
    expect(bumpStep.run.indexOf('git add package.json')).toBeGreaterThan(generateIndex)
    expect(stagedPaths).toEqual(['package.json', 'resources/skills/release-mapping.json'])
    // Every distinct mention must be staged, so a copy, a redirect, or a path
    // held in a variable cannot reach the content-addressed artifacts. Matched
    // without a trailing slash so `dir="resources/skills"` still counts.
    expect([...mentioned]).toEqual(stagedPaths.slice(1))
    // Regeneration is banned job-wide by the generator suite. Here: `-a`, `-am`,
    // and `--all` sweep unstaged artifacts in; `--allow-empty` below must not.
    expect(commands).not.toMatch(/\bcommit\b[^\n]*(?:\s-[a-z]*a[a-z]*\b|\s--all\b)/)
    expect(bumpStep.run).toContain('git diff --cached --quiet')
    expect(bumpStep.run).toContain('git commit --allow-empty -m "$commit_message"')
  })

  it('keeps release-cut RC retries monotonic across stale attempts', () => {
    const releaseWorkflow = readFileSync(
      join(projectDir, '.github/workflows/release-cut.yml'),
      'utf8'
    )
    const parsedWorkflow = parse(releaseWorkflow)
    const versionStep = parsedWorkflow.jobs.cut.steps.find(
      (step) => step.name === 'Compute next version'
    )

    expect(versionStep.run).toContain('node config/scripts/release-rc-history.mjs "$1"')
    expect(versionStep.run).toContain('tag_matches_current_ref')
    expect(versionStep.run).toContain('cutting the next version instead of reusing stale artifacts')
    expect(versionStep.run).toContain('git rev-parse "$existing_rc_tag"')
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
    const installStep = parsedWorkflow.jobs.test.steps.find(
      (step) => step.name === 'Install Electron package binary for tests'
    )

    expect(installStep.run).toBe('node config/scripts/install-electron-package-binary.mjs')
  })

  it('smokes the packaged CLI from outside the checkout in PR checks', () => {
    const prWorkflow = readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8')
    const parsedWorkflow = parse(prWorkflow)
    const smokeStep = parsedWorkflow.jobs.package.steps.find(
      (step) => step.name === 'Smoke packaged CLI'
    )

    expect(smokeStep.run).toBe(
      'node config/scripts/smoke-packaged-cli.mjs --app-dir=dist/linux-unpacked'
    )
  })

  it('keeps terminal scale perf wired to the report budget gate', () => {
    const packageScripts = packageJson.scripts
    const terminalPerfWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/terminal-perf.yml'), 'utf8')
    )
    const steps = terminalPerfWorkflow.jobs['terminal-perf'].steps
    const runStep = steps.find((step) => step.name === 'Run terminal scale perf report gate')
    const uploadStep = steps.find((step) => step.name === 'Upload terminal perf report')

    expect(packageScripts['test:e2e:terminal-perf:scale:report']).toContain(
      'run-terminal-scale-perf-report-gate.mjs'
    )
    expect(runStep.run).toContain('pnpm run test:e2e:terminal-perf:scale:report')
    expect(runStep.run).toContain('xvfb-run --auto-servernum')
    const manualProfileKnobs = [
      ['ORCA_TERMINAL_PERF_FRAME_COUNT', 'frame_count', 'ORCA_E2E_OPENCODE_FRAME_COUNT'],
      [
        'ORCA_TERMINAL_PERF_FRAME_INTERVAL_MS',
        'frame_interval_ms',
        'ORCA_E2E_OPENCODE_FRAME_INTERVAL_MS'
      ],
      [
        'ORCA_TERMINAL_PERF_PRESSURE_OUTPUT_CHARS',
        'pressure_output_chars',
        'ORCA_E2E_OPENCODE_PRESSURE_OUTPUT_CHARS'
      ],
      ['ORCA_TERMINAL_PERF_SCALE_PANES', 'scale_panes', 'ORCA_E2E_OPENCODE_SCALE_PANES'],
      [
        'ORCA_TERMINAL_PERF_SCALE_CROSS_WORKSPACE_PANES',
        'scale_cross_workspace_panes',
        'ORCA_E2E_OPENCODE_SCALE_CROSS_WORKSPACE_PANES'
      ],
      [
        'ORCA_TERMINAL_PERF_SCALE_PRESSURE_PANES',
        'scale_pressure_panes',
        'ORCA_E2E_OPENCODE_SCALE_PRESSURE_PANES'
      ],
      [
        'ORCA_TERMINAL_PERF_SCALE_HIDDEN_PRESSURE_PANES',
        'scale_hidden_pressure_panes',
        'ORCA_E2E_OPENCODE_SCALE_HIDDEN_PRESSURE_PANES'
      ]
    ]
    for (const [workflowEnv, inputName, runnerEnv] of manualProfileKnobs) {
      expect(runStep.env[workflowEnv]).toBe(`\${{ inputs.${inputName} }}`)
      expect(runStep.run).toContain(runnerEnv)
    }
    expect(uploadStep.uses).toBe('actions/upload-artifact@v7')
    expect(uploadStep.with.path).toBe('${{ env.ORCA_E2E_TERMINAL_PERF_REPORT_PATH }}')
  })

  it('keeps terminal rendering regressions in the manual golden E2E workflow', () => {
    const packageScripts = packageJson.scripts
    const goldenWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/golden-e2e-experiment.yml'), 'utf8')
    )
    const releaseWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const steps = goldenWorkflow.jobs['golden-e2e'].steps
    const goldenPlatformLabels = new Map([
      ['linux', 'Linux'],
      ['mac', 'macOS'],
      ['windows', 'Windows']
    ])
    const goldenPlatforms = goldenWorkflow.jobs['golden-e2e'].strategy.matrix.include
      .map(({ platform }) => platform)
      .sort()
    const goldenRunSteps = goldenPlatforms.map((platform) => {
      const label = goldenPlatformLabels.get(platform)

      expect(label, platform).toBeDefined()

      return steps.find((step) => step.name === `Run golden E2E tests on ${label}`)
    })
    const releaseGoldenJob = releaseWorkflow.jobs['terminal-rendering-golden']
    const releaseEvidenceJob = releaseWorkflow.jobs['terminal-rendering-release-evidence']
    const releaseBuildNeeds = releaseWorkflow.jobs.build.needs
    const publishReleaseNeeds = releaseWorkflow.jobs['publish-release'].needs
    // Why: Windows release evidence is temporarily paused for CI runner PTY readiness.
    const releaseEvidencePlatforms = ['linux', 'mac']

    expect(packageScripts['test:e2e:terminal-rendering-golden']).toContain(
      '@terminal-rendering-golden'
    )
    expect(packageScripts['test:e2e:terminal-rendering-golden']).toContain(
      'terminal-raw-emoji-table-scroll-restore.spec.ts'
    )
    expect(packageScripts['test:e2e:terminal-rendering-golden']).toContain(
      'terminal-webgl-atlas-budget.spec.ts'
    )
    expect(packageScripts['test:e2e:terminal-rendering-golden']).not.toContain(
      'terminal-long-table-scroll-restore.spec.ts'
    )
    expect(packageScripts['test:e2e:terminal-rendering-release-evidence']).toContain(
      'terminal-opencode-emoji-table-rendering.spec.ts'
    )
    expect(packageScripts['test:e2e:terminal-rendering-release-evidence']).toContain(
      'terminal-long-table-scroll-restore.spec.ts'
    )
    for (const runStep of goldenRunSteps) {
      expect(runStep?.run).toContain('pnpm run test:e2e:terminal-rendering-golden')
    }
    expect(goldenWorkflow.on.pull_request).toBeUndefined()
    expect(goldenWorkflow.on.workflow_dispatch).toBeDefined()
    expect(releaseBuildNeeds).not.toContain('terminal-rendering-golden')
    expect(releaseBuildNeeds).not.toContain('terminal-rendering-release-evidence')
    expect(publishReleaseNeeds).toContain('terminal-rendering-golden')
    expect(publishReleaseNeeds).toContain('build')
    expect(publishReleaseNeeds).not.toContain('terminal-rendering-release-evidence')
    expect(releaseGoldenJob['continue-on-error']).toBeUndefined()
    expect(releaseGoldenJob.strategy.matrix.include.map(({ platform }) => platform).sort()).toEqual(
      goldenPlatforms
    )
    expect(releaseGoldenJob.steps.map((step) => step.run ?? '')).toContain(
      'xvfb-run --auto-servernum env SKIP_BUILD=1 ORCA_E2E_FORWARD_APP_LOGS=1 pnpm run test:e2e:terminal-rendering-golden'
    )
    expect(releaseEvidenceJob['continue-on-error']).toBe(true)
    expect(
      releaseEvidenceJob.strategy.matrix.include.map(({ platform }) => platform).sort()
    ).toEqual(releaseEvidencePlatforms)
    expect(releaseEvidenceJob.steps.map((step) => step.run ?? '')).toContain(
      'xvfb-run --auto-servernum env SKIP_BUILD=1 ORCA_E2E_FORWARD_APP_LOGS=1 pnpm run test:e2e:terminal-rendering-release-evidence'
    )
  })
})
