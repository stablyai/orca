import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('computer-use e2e workflow', () => {
  it('runs computer-use e2e files serially because they share desktop focus', () => {
    const config = readFileSync(join(projectDir, 'tests/e2e/vitest.config.ts'), 'utf8')

    expect(config).toContain('fileParallelism: false')
  })

  it('guards e2e source against fragile fixed waits and stale element indexes', () => {
    const driver = readFileSync(join(projectDir, 'tests/e2e/helpers/computer-driver.ts'), 'utf8')
    const cliDriver = readFileSync(
      join(projectDir, 'tests/e2e/helpers/computer-cli-driver.ts'),
      'utf8'
    )
    const windowsStoreE2e = readFileSync(
      join(projectDir, 'tests/e2e/computer-windows-store.e2e.ts'),
      'utf8'
    )

    expect(driver).not.toContain('await delay(3500)')
    expect(driver).toContain("await waitForComputerWindowTitle('gedit', fileName, 15000)")
    expect(cliDriver).toContain('ORCA_DEV_USER_DATA_PATH')
    expect(cliDriver).toContain('orca-computer-runtime-')
    expect(cliDriver).toContain('retryMissingRuntimeMetadata')
    expect(cliDriver).toContain('Could not read Orca runtime metadata')
    expect(cliDriver).toContain("'serve', '--no-pairing', '--json'")

    expect(windowsStoreE2e).toMatch(
      /for \(const buttonName of \['One', 'Plus', 'Two', 'Equals'\]\) \{[\s\S]*findRoleIndex\(state\.result\.snapshot\.treeText, `button \$\{buttonName\}`\)[\s\S]*state = parseJsonOutput/
    )
    expect(windowsStoreE2e).not.toMatch(/const one = findRoleIndex/)
    expect(windowsStoreE2e).not.toMatch(/for \(const index of \[one, plus, two, equals\]\)/)
  })

  it('triggers on computer-use shared contracts, scripts, and agent skill changes', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const triggerPaths = workflow.on.pull_request.paths

    expect(triggerPaths).toEqual(
      expect.arrayContaining([
        'config/scripts/computer-e2e-workflow.test.mjs',
        'config/scripts/computer-use-skill-guidance.test.mjs',
        'config/scripts/computer-use-smoke.mjs',
        'config/scripts/computer-use-smoke.test.mjs',
        'skills/computer-use/SKILL.md',
        'src/main/computer/**',
        'src/main/runtime/rpc/dispatcher.ts',
        'src/main/runtime/rpc/errors.ts',
        'src/main/runtime/rpc/methods/computer*.ts',
        'src/shared/computer-use-*.ts',
        'tests/e2e/vitest.config.ts'
      ])
    )
    expect(triggerPaths).not.toContain('src/shared/runtime-types.ts')
  })

  it('runs focused computer-use regression tests in the PR native-smoke job', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const nativeSmokeRuns = workflow.jobs['native-smoke'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const regressionRun = nativeSmokeRuns.find((run) => run.includes('pnpm vitest run'))
    const expectedRegressionFiles = [
      'config/scripts/computer-e2e-workflow.test.mjs',
      'config/scripts/computer-use-skill-guidance.test.mjs',
      'config/scripts/computer-use-smoke.test.mjs',
      'src/main/computer/computer-provider-lifecycle.test.ts',
      'src/main/computer/computer-provider-unavailable-message.test.ts',
      'src/main/computer/sidecar-client.test.ts',
      'src/main/computer/macos-native-provider-client.test.ts',
      'src/main/computer/macos-native-provider-socket.test.ts',
      'src/main/computer/macos-computer-use-permissions.test.ts',
      'src/main/computer/macos-computer-use-permission-status.test.ts',
      'src/main/computer/desktop-script-provider-client.test.ts',
      'src/main/computer/desktop-script-provider-cache.test.ts',
      'src/main/computer/desktop-script-provider-actions.test.ts',
      'src/main/computer/desktop-script-provider-cache-lifecycle.test.ts',
      'src/main/computer/desktop-script-provider-errors.test.ts',
      'src/main/computer/desktop-script-provider-action-errors.test.ts',
      'src/shared/computer-use-error-recovery.test.ts',
      'src/shared/computer-use-key-spec.test.ts',
      'src/cli/format.test.ts',
      'src/cli/handlers/computer.test.ts',
      'src/cli/handlers/computer-action-routing.test.ts',
      'src/cli/handlers/computer-action-validation.test.ts',
      'src/cli/handlers/computer-state-formatting.test.ts',
      'src/cli/specs/computer.test.ts',
      'src/cli/index.test.ts',
      'src/main/runtime/rpc/dispatcher-computer-errors.test.ts',
      'src/main/runtime/rpc/errors.test.ts',
      'src/main/runtime/rpc/methods/computer.test.ts',
      'src/main/runtime/rpc/methods/computer-actions.test.ts',
      'src/cli/runtime/envelope-schema.test.ts',
      'src/shared/remote-runtime-client.test.ts'
    ]

    expect(regressionRun).toBeTruthy()
    for (const file of expectedRegressionFiles) {
      expect(regressionRun).toContain(file)
    }
  })

  it('runs Linux computer-use e2e in the PR native-smoke job under Xvfb', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const nativeSmokeRuns = workflow.jobs['native-smoke'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const installRun = nativeSmokeRuns.find((run) => run.includes('apt-get install'))

    expect(installRun).toContain('gedit')
    expect(installRun).toContain('xvfb')
    expect(nativeSmokeRuns).toContain(
      'xvfb-run --auto-servernum dbus-run-session -- pnpm test:e2e:computer --reporter=verbose tests/e2e/computer-linux.e2e.ts'
    )
  })

  it('builds Electron main output before every computer-use e2e run', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )

    for (const jobName of ['native-smoke', 'mac', 'linux', 'windows']) {
      const runs = workflow.jobs[jobName].steps
        .map((step) => step.run)
        .filter((run) => typeof run === 'string')
      const buildIndex = runs.indexOf('pnpm build:electron-vite')
      const e2eIndexes = runs
        .map((run, index) => (run.includes('test:e2e:computer') ? index : -1))
        .filter((index) => index >= 0)

      expect(
        buildIndex,
        `${jobName} should build out/main before computer e2e`
      ).toBeGreaterThanOrEqual(0)
      for (const e2eIndex of e2eIndexes) {
        expect(buildIndex, `${jobName} should build out/main before computer e2e`).toBeLessThan(
          e2eIndex
        )
      }
    }
  })

  it('runs core Windows computer-use e2e in the PR native-smoke job', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const nativeSmokeRuns = workflow.jobs['native-smoke'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const allRuns = [
      ...nativeSmokeRuns,
      ...workflow.jobs.mac.steps.map((step) => step.run).filter((run) => typeof run === 'string'),
      ...workflow.jobs.linux.steps.map((step) => step.run).filter((run) => typeof run === 'string'),
      ...workflow.jobs.windows.steps
        .map((step) => step.run)
        .filter((run) => typeof run === 'string')
    ]

    expect(nativeSmokeRuns).toContain(
      'pnpm test:e2e:computer --reporter=verbose tests/e2e/computer-windows.e2e.ts'
    )
    expect(allRuns.join('\n')).not.toContain('test:e2e:computer -- --reporter')
  })

  it('runs macOS and Linux computer-use e2e files in scheduled jobs', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const triggerPaths = workflow.on.pull_request.paths
    const macRuns = workflow.jobs.mac.steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const linuxRuns = workflow.jobs.linux.steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')

    expect(triggerPaths).toEqual(
      expect.arrayContaining([
        'tests/e2e/computer-mac.e2e.ts',
        'tests/e2e/computer-mac-safari.e2e.ts',
        'tests/e2e/computer-linux.e2e.ts',
        'tests/e2e/helpers/computer-cli-driver.ts',
        'tests/e2e/helpers/computer-driver.ts'
      ])
    )
    expect(macRuns).toContain(
      'pnpm test:e2e:computer --reporter=verbose tests/e2e/computer-mac.e2e.ts tests/e2e/computer-mac-safari.e2e.ts'
    )
    expect(linuxRuns).toContain(
      'xvfb-run --auto-servernum dbus-run-session -- pnpm test:e2e:computer --reporter=verbose tests/e2e/computer-linux.e2e.ts'
    )
  })

  it('runs every Windows computer-use e2e file in the scheduled Windows job', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const triggerPaths = workflow.on.pull_request.paths
    const windowsRuns = workflow.jobs.windows.steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')

    expect(triggerPaths).toEqual(
      expect.arrayContaining([
        'tests/e2e/computer-windows.e2e.ts',
        'tests/e2e/computer-windows-store.e2e.ts'
      ])
    )
    expect(windowsRuns).toContain(
      'pnpm test:e2e:computer --reporter=verbose tests/e2e/computer-windows.e2e.ts tests/e2e/computer-windows-store.e2e.ts'
    )
  })
})
