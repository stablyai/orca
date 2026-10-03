import { existsSync, globSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { UNIT_EXCLUDE } from './ci-unit-files.mjs'
import { MOBILE_WEB_APP_DEPENDENCIES_REQUIRED_ENV } from './mobile-web-app-bundle-dependencies.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const prTestLocWorkflow = parse(readFileSync('.github/workflows/pr-test-loc.yml', 'utf8'))
const releasePolicyWorkflow = parse(readFileSync('.github/workflows/release-policy.yml', 'utf8'))
const issueLabelWorkflow = parse(readFileSync('.github/workflows/issue-os-labeler.yaml', 'utf8'))
const unitTestWorkflow = parse(readFileSync('.github/workflows/unit-tests.yml', 'utf8'))
const nodeNextWorkflow = parse(readFileSync('.github/workflows/node-next-compat.yml', 'utf8'))
const dependencyAction = parse(
  readFileSync('.github/actions/install-node-dependencies/action.yml', 'utf8')
)
const nativeAction = parse(
  readFileSync('.github/actions/prepare-native-runtime/action.yml', 'utf8')
)
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const pnpmWorkspace = parse(readFileSync('pnpm-workspace.yaml', 'utf8'))
const shellContractFiles = [
  'src/main/daemon/repro-13767-shell-ready-marker-lost-to-exec.test.ts',
  'src/main/daemon/shell-ready.test.ts',
  'src/main/providers/local-pty-shell-ready-zsh-launch-environment.test.ts',
  'src/main/providers/__tests__/shell-ready-framework-example.test.ts',
  'src/main/pty/omp-shell-wrapper-alias-safety.test.ts',
  'src/main/pty/omp-shell-wrapper.node-pty.test.ts',
  'src/main/shell-startup-feature-channel.test.ts',
  'src/main/zsh-scoped-histfile.live-shell.test.ts',
  'src/main/zsh-startup-hook-user-config-equivalence.live-shell.test.ts',
  'src/main/zsh-wrapper-version-mismatch.live-shell.test.ts',
  'src/main/runtime/structured-session-cli-login-shell.live-shell.test.ts',
  'src/shared/posix-command-path-lookup.test.ts'
]
const patchedNodePtyContractFiles = [
  'src/main/daemon/node-pty-fd-leak.test.ts',
  'src/shared/fish-query-reply-child-stdin.node-pty.test.ts'
]
const nativeShellContractFiles = [...shellContractFiles, ...patchedNodePtyContractFiles]
const testFilePatterns = [
  'config/**/*.{test,spec}.{js,cjs,mjs,ts,tsx}',
  'src/**/*.{test,spec}.{js,cjs,mjs,ts,tsx}',
  'tests/**/*.{test,spec}.{js,cjs,mjs,ts,tsx}',
  'tests/tools/**/*.{test,spec}.{js,cjs,mjs,ts,tsx}'
]
// Why the harness import counts: the zsh startup hook runs from a `precmd`, so
// its tests drive a real zsh through a PTY in zsh-startup-hook-pty-harness
// rather than calling spawnSync('zsh') themselves. Without this branch the rule
// silently stops noticing the very tests that need the lane's zsh install.
const realZshUsage =
  /(?:spawnSync|execFileSync|spawn)\(\s*['"](?:\/(?:usr\/)?bin\/)?zsh['"]|program:\s*['"](?:\/(?:usr\/)?bin\/)?zsh['"]|spawnSync\(\s*['"]which['"]\s*,\s*\[\s*['"]zsh['"]|name:\s*['"]zsh['"]\s*,\s*path:\s*executablePath|from '[^']*zsh-startup-hook-pty-harness'/

describe('PR workflow parallelism', () => {
  it('keeps lightweight orchestration jobs on the free slim runner', () => {
    expect(workflow.jobs.code_paths['runs-on']).toBe('ubuntu-slim')
    expect(workflow.jobs.typecheck['runs-on']).toBe('ubuntu-24.04-arm')
    expect(workflow.jobs.verify['runs-on']).toBe('ubuntu-slim')
    expect(prTestLocWorkflow.jobs.loc['runs-on']).toBe('ubuntu-slim')
    expect(releasePolicyWorkflow.jobs.enforce['runs-on']).toBe('ubuntu-slim')
    expect(issueLabelWorkflow.jobs['apply-os-label']['runs-on']).toBe('ubuntu-slim')
  })

  it('cancels superseded runs for the same pull request', () => {
    expect(workflow.concurrency.group).toBe('pr-checks-${{ github.event.pull_request.number }}')
    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
    expect(workflow.jobs.test.if).toContain('!cancelled()')
    expect(workflow.jobs.test.if).not.toContain('always()')
    expect(workflow.jobs.verify.if).toBe('${{ !cancelled() }}')
  })

  it('grants the PR workflow read-only repository access', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('runs PR shards on ARM and both Node versions on x86 daily', () => {
    const sharedTest = unitTestWorkflow.jobs.test
    const testStep = sharedTest.steps.find((step) => step.name === 'Test shard')
    const installStep = sharedTest.steps.find(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
    const staticInstall = workflow.jobs.static_analysis.steps.find(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
    const nodeNextPrimerInstall = nodeNextWorkflow.jobs.test_native_cache.steps.find(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )

    expect(workflow.jobs.test.uses).toBe('./.github/workflows/unit-tests.yml')
    expect(JSON.parse(workflow.jobs.test.with.node_versions)).toEqual(['24'])
    expect(nodeNextWorkflow.jobs.test.uses).toBe('./.github/workflows/unit-tests.yml')
    expect(JSON.parse(nodeNextWorkflow.jobs.test.with.node_versions)).toEqual(['24', '26'])
    expect(workflow.jobs.test.with.runner).toBe('ubuntu-24.04-arm')
    expect(workflow.jobs.static_analysis['runs-on']).toBe('ubuntu-24.04-arm')
    expect(sharedTest['runs-on']).toBe('${{ inputs.runner }}')
    expect(unitTestWorkflow.on.workflow_call.inputs.runner.default).toBe('ubuntu-latest')
    expect(nodeNextWorkflow.jobs.test.with.runner).toBeUndefined()
    expect(nodeNextWorkflow.jobs.test_native_cache['runs-on']).toBe('ubuntu-latest')
    expect(nodeNextWorkflow.jobs.test_native_cache.strategy.matrix.node).toEqual(['24', '26'])
    const relay = unitTestWorkflow.jobs.relay_integration
    expect(relay.strategy.matrix.node).toBe('${{ fromJSON(inputs.node_versions) }}')
    expect(relay['runs-on']).toBe('ubuntu-latest')
    expect(
      relay.steps.find((step) => step.uses === './.github/actions/install-node-dependencies').with[
        'node-version'
      ]
    ).toBe('${{ matrix.node }}')
    expect(nodeNextWorkflow.on.schedule).toHaveLength(1)
    expect(nodeNextWorkflow.on.workflow_dispatch).toBeNull()
    expect(sharedTest.strategy.matrix.node).toBe('${{ fromJSON(inputs.node_versions) }}')
    expect(sharedTest.strategy.matrix.shard).toBe('${{ fromJSON(inputs.shards) }}')
    // PR planning overlaps typecheck; the daily suite keeps its separate planner.
    expect(sharedTest.needs).toBeUndefined()
    expect(unitTestWorkflow.jobs.plan).toBeUndefined()
    expect(unitTestWorkflow.on.workflow_call.inputs.shards.required).toBe(true)
    expect(installStep.with['node-version']).toBe('${{ matrix.node }}')
    expect(installStep.with['cache-electron-package']).toBe('true')
    expect(testStep.run).toContain('--shard=${{ matrix.shard.index }}/${{ matrix.shard.count }}')
    for (const testFile of nativeShellContractFiles) {
      expect(UNIT_EXCLUDE).toContain(testFile)
    }
    expect(staticInstall.with['native-runtime']).toBe('node')
    expect(staticInstall.with['node-version']).toBe('24')
    expect(workflow.jobs.test.needs).toContain('static_analysis')
    expect(workflow.jobs.test_native_cache).toBeUndefined()
    expect(nodeNextPrimerInstall.with['native-runtime']).toBe('node')
    expect(nodeNextPrimerInstall.with['node-version']).toBe('${{ matrix.node }}')
    expect(nodeNextWorkflow.jobs.test.needs).toEqual(['test_native_cache', 'unit_plan'])
  })

  it('runs real-shell coverage once outside the general shards', () => {
    const shellStep = workflow.jobs.shell_contracts.steps.find(
      (step) => step.name === 'Test real shell contracts'
    )
    const shellInstall = workflow.jobs.shell_contracts.steps.find(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
    // Why parsed rather than substring-matched: the step name changes as shells are
    // added, and `includes('fish')` would also match a comment or a longer package.
    const aptPackages = (step) =>
      (step.run?.match(/apt-get install[^\n]*/)?.[0] ?? '')
        .split(/\s+/)
        .filter((token) => !['apt-get', 'install', 'sudo', ''].includes(token))
        .filter((token) => !token.startsWith('-'))
    const requiredShells = ['zsh', 'fish']
    const jobsInstallingShells = Object.entries(workflow.jobs)
      .filter(([, job]) =>
        (job.steps ?? []).some((step) =>
          aptPackages(step).some((packageName) => requiredShells.includes(packageName))
        )
      )
      .map(([name]) => name)

    expect(shellStep).toBeDefined()
    expect(shellInstall).toBeDefined()
    expect(shellStep.run.split(/\s+/)).toContain('--maxWorkers=1')
    // Why the whole workflow, not just the general shards: any other lane installing
    // these shells would silently start running the real-shell tests twice.
    expect(jobsInstallingShells).toEqual(['shell_contracts'])
    // Why each shell is asserted: the live tests skip themselves when the binary is
    // missing, so a dropped package silently empties this lane instead of failing it.
    const shellPackages = workflow.jobs.shell_contracts.steps.flatMap(aptPackages)
    for (const shell of requiredShells) {
      expect(shellPackages).toContain(shell)
    }
    expect(shellInstall.with['native-runtime']).toBe('node')
    for (const testFile of nativeShellContractFiles) {
      expect(shellStep.run).toContain(testFile)
    }
  })

  it('refreshes the apt index once while adding the fish PPA', () => {
    const installStep = workflow.jobs.shell_contracts.steps.find(
      (step) => step.name === 'Install zsh and fish'
    )
    // Comment lines mention both commands by name, so count the executed ones only.
    const commands = installStep.run
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    const updates = commands.match(/apt-get update/g) ?? []
    // Anchored to the start of a line so the retry message that names the command in
    // prose is not mistaken for an invocation of it.
    const addRepoCalls = commands
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(sudo\s+)?add-apt-repository\b/.test(line))

    // add-apt-repository refreshes every configured repo unless told not to, so an
    // update on each side of it made this step pay for three full passes.
    expect(updates).toHaveLength(1)
    expect(addRepoCalls.length).toBeGreaterThan(0)
    for (const call of addRepoCalls) {
      expect(call.split(/\s+/)).toContain('-n')
    }
    // The one remaining update has to come after the PPA is on the list, or the fish
    // index it exists to fetch would not be there yet.
    expect(commands.lastIndexOf('add-apt-repository')).toBeLessThan(
      commands.indexOf('apt-get update')
    )
  })

  it('bounds the shell lane so a stalled apt mirror cannot hold the run open', () => {
    const job = workflow.jobs.shell_contracts
    // A passing run of this job takes ~4.5 minutes, almost all of it package download.
    // Without a job bound a stalled mirror runs to GitHub's 6h default, and because this
    // is a required check it holds the whole run open and blocks `gh run rerun --failed`.
    expect(job['timeout-minutes']).toBeGreaterThan(0)
    expect(job['timeout-minutes']).toBeLessThanOrEqual(30)

    const installStep = job.steps.find((step) => step.name === 'Install zsh and fish')
    // apt applies no wall-clock bound to a stalled mirror on its own. These turn an
    // unbounded hang into a bounded, retried, legible failure.
    expect(installStep.run).toMatch(/Acquire::http::Timeout/)
    expect(installStep.run).toMatch(/Acquire::https::Timeout/)
    expect(installStep.run).toMatch(/Acquire::Retries/)
    // Retries multiply: a first attempt at 30s x 3 retries across every index file turned
    // a dead mirror into a ~15 minute stall. One attempt, then move on.
    expect(installStep.run).toMatch(/Acquire::Retries "1"/)
    // Acquire timeouts are per-connection, so they cannot bound the command as a whole.
    // Only a wall-clock bound can, and both apt invocations need one.
    expect(installStep.run).toMatch(/timeout \d+ sudo apt-get update/)
    expect(installStep.run).toMatch(/timeout \d+ sudo apt-get install/)
  })

  it('keeps every real-zsh test in the dedicated shell lane', () => {
    const discoveredFiles = globSync(testFilePatterns)
      // Why this file is excluded: it carries the detector pattern as a literal
      // and would otherwise match itself.
      .filter((testFile) => testFile !== 'config/scripts/pr-workflow-parallelism.test.mjs')
      // TypeScript builds can leave an ignored JavaScript companion beside a source
      // test. Inspect the source file once so generated output cannot duplicate it.
      .filter(
        (testFile) =>
          !testFile.endsWith('.js') ||
          !['.ts', '.tsx', '.mjs', '.cjs'].some((extension) =>
            existsSync(testFile.replace(/\.js$/, extension))
          )
      )
      .filter((testFile) => realZshUsage.test(readFileSync(testFile, 'utf8')))
      .sort()

    expect(discoveredFiles).toEqual([...shellContractFiles].sort())
  })

  it('overlaps bundles with independent output directories', () => {
    const buildStep = workflow.jobs.package.steps.find(
      (step) => step.name === 'Build package inputs'
    )

    expect(buildStep.run).toContain('scripts=(build:relay build:electron-vite:parallel)')
    expect(buildStep.run).toContain('pnpm run "$script" &')
    expect(
      workflow.jobs.package.steps.find(
        (step) => step.name === 'Project web client from renderer build'
      ).run
    ).toBe('pnpm run build:web-from-renderer')
    expect(packageJson.scripts['build:desktop']).toContain('pnpm run build:web-from-renderer')
    expect(packageJson.scripts['build:release']).toContain('pnpm run build:web-from-renderer')
  })

  it('smokes managed-hook companions under their supported Node 18 runtime', () => {
    const steps = workflow.jobs.managed_hook_node18.steps
    const installIndex = steps.findIndex(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
    const buildIndex = steps.findIndex((step) => step.run === 'pnpm run build:relay')
    const node18Index = steps.findIndex(
      (step) => step.uses === 'actions/setup-node@v6' && step.with['node-version'] === '18'
    )
    const smokeIndex = steps.findIndex(
      (step) => step.run === 'node config/scripts/smoke-managed-hook-runtime-node18.mjs'
    )

    expect(installIndex).toBeLessThan(buildIndex)
    expect(buildIndex).toBeLessThan(node18Index)
    expect(node18Index).toBeLessThan(smokeIndex)
  })

  it('restores the pnpm store before dependency installation', () => {
    const steps = dependencyAction.runs.steps
    const pnpmIndex = steps.findIndex((step) => step.name === 'Setup pnpm')
    const nodeIndex = steps.findIndex((step) => step.name === 'Setup Node.js')
    const requestedNodeIndex = steps.findIndex((step) => step.name === 'Setup requested Node.js')

    expect(pnpmIndex).toBeLessThan(nodeIndex)
    expect(pnpmIndex).toBeLessThan(requestedNodeIndex)
    const packageManagerVersion = /^pnpm@([^+]+)/.exec(packageJson.packageManager)?.[1]
    expect(packageManagerVersion).toBe('12.8.1')
    expect(steps[pnpmIndex].uses).toBe('pnpm/setup@v2')
    expect(steps[pnpmIndex].with.version).toBeUndefined()
    expect(steps[pnpmIndex].with.install).toBe(false)
    const saveOutsidePrs =
      "${{ github.event_name != 'pull_request' && inputs.cache-pnpm-store != 'false' && inputs.cache-pnpm-store-lookup-only != 'true' && 'pnpm' || '' }}"
    expect(steps[nodeIndex].with.cache).toBe(saveOutsidePrs)
    expect(steps[nodeIndex].if).toBe("inputs.node-version == ''")
    expect(steps[requestedNodeIndex].if).toBe("inputs.node-version != ''")
    expect(steps[requestedNodeIndex].with['node-version']).toBe('${{ inputs.node-version }}')
    expect(steps[requestedNodeIndex].with.cache).toBe(saveOutsidePrs)
    const restoreIndex = steps.findIndex(
      (step) => step.name === 'Restore pnpm download store without saving'
    )
    expect(restoreIndex).toBeGreaterThan(requestedNodeIndex)
    expect(restoreIndex).toBeLessThan(
      steps.findIndex((step) => step.name === 'Install dependencies')
    )
    expect(steps[restoreIndex].uses).toBe('actions/cache/restore@v5')
    expect(steps[restoreIndex].if).toBe(
      "github.event_name == 'pull_request' && inputs.cache-pnpm-store != 'false' && !((runner.os == 'Linux' || runner.os == 'macOS') && (runner.arch == 'X64' || runner.arch == 'ARM64') && inputs.cache-dependency-path == 'pnpm-lock.yaml') && (runner.os != 'Windows' || !(runner.arch == 'X64' && contains(inputs.cache-dependency-path, 'mobile/pnpm-lock.yaml')) && !((runner.arch == 'X64' || runner.arch == 'ARM64') && inputs.cache-dependency-path == 'pnpm-lock.yaml'))"
    )
  })

  it('uses the repository package-manager version for every direct pnpm setup', () => {
    const directSetups = globSync('.github/workflows/*.yml').flatMap((workflowPath) => {
      const parsed = parse(readFileSync(workflowPath, 'utf8'))
      return Object.values(parsed.jobs ?? {}).flatMap((job) =>
        (job.steps ?? [])
          .filter((step) => step.uses === 'pnpm/setup@v2')
          .map((step) => ({ workflowPath, step }))
      )
    })

    expect(directSetups.length).toBeGreaterThan(0)
    for (const { workflowPath, step } of directSetups) {
      expect(step.with?.version, workflowPath).toBeUndefined()
      expect(step.with?.install, workflowPath).toBe(false)
    }
  })

  it('restores Electron downloads before preparing the package runtime', () => {
    const steps = workflow.jobs.package.steps
    const cacheIndex = steps.findIndex((step) => step.name === 'Cache electron-builder downloads')
    const installIndex = steps.findIndex(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )

    expect(cacheIndex).toBeGreaterThanOrEqual(0)
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(cacheIndex).toBeLessThan(installIndex)
  })

  it('prepares each native runtime before its consumers start', () => {
    const installFor = (jobName) =>
      workflow.jobs[jobName].steps.find(
        (step) => step.uses === './.github/actions/install-node-dependencies'
      )
    const sharedTestInstall = unitTestWorkflow.jobs.test.steps.find(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )

    for (const jobName of ['typecheck', 'git_compatibility']) {
      expect(installFor(jobName).with, jobName).toBeUndefined()
    }
    expect(installFor('xterm_patch_sync')).toBeUndefined()
    expect(installFor('static_analysis').with['native-runtime']).toBe('node')
    expect(installFor('shell_contracts').with['native-runtime']).toBe('node')
    expect(sharedTestInstall.with['native-runtime']).toBe('node')
    expect(installFor('package').with['native-runtime']).toBe('electron')
    expect(installFor('package_windows').with['native-runtime']).toBe('node')
    expect(installFor('package_windows').with['persist-native-cache']).toBe('false')
    expect(
      workflow.jobs.package_windows.steps.find(
        (step) => step.name === 'Save compiled Node native modules'
      ).if
    ).toBe("steps.deps.outputs.native-cache-hit != 'true'")

    expect(dependencyAction.inputs['persist-native-cache'].default).toBe('true')
    expect(nativeAction.runs.steps.find((step) => step.name === 'Use external node-gyp').if).toBe(
      "runner.os == 'Linux' && inputs.native-runtime == 'node'"
    )
    const dependencyInstall = dependencyAction.runs.steps.find(
      (step) => step.name === 'Install dependencies'
    )
    // Why frozen: re-resolving the graph costs a minute per job and the `git diff`
    // guard below already fails the run when the lockfile is stale, so the slow
    // resolution can never legitimately change anything.
    expect(dependencyInstall.run).toContain('--frozen-lockfile')
    expect(dependencyInstall.run).not.toContain('--no-frozen-lockfile')
    expect(dependencyInstall.run).toContain(
      'git -C "$GITHUB_WORKSPACE" diff --exit-code -- package.json pnpm-lock.yaml pnpm-workspace.yaml'
    )
    expect(dependencyInstall.run).toContain('--ignore-scripts')
    expect(dependencyInstall.run).not.toContain('--os=')
    expect(dependencyInstall.run).not.toContain('--cpu=')
    expect(pnpmWorkspace.supportedArchitectures.os).toEqual(['current'])
    expect(pnpmWorkspace.supportedArchitectures.cpu).toEqual(['current'])
    const prepareRuntime = dependencyAction.runs.steps.find(
      (step) => step.name === 'Prepare native runtime'
    )
    expect(prepareRuntime.if).toBe("inputs.native-runtime != 'none'")
    expect(prepareRuntime.uses).toBe('./.github/actions/prepare-native-runtime')
    expect(prepareRuntime.with).toEqual({
      'native-runtime': '${{ inputs.native-runtime }}',
      'node-version':
        '${{ steps.requested-node.outputs.node-version || steps.default-node.outputs.node-version }}',
      'persist-native-cache': '${{ inputs.persist-native-cache }}'
    })
  })

  it('reuses native preparation after the dependency action gate', () => {
    const buildStep = workflow.jobs.package.steps.find(
      (step) => step.name === 'Build package inputs'
    )
    const packageStep = workflow.jobs.package.steps.find(
      (step) => step.name === 'Package unpacked app'
    )

    expect(buildStep.run).not.toContain('ensure:electron-runtime')
    expect(packageStep.env.ORCA_REUSE_PREPARED_NATIVE_RUNTIME).toBe('1')
  })

  it('restores compiled native modules after the install that strips them', () => {
    const installerSteps = dependencyAction.runs.steps
    const installIndex = installerSteps.findIndex((step) => step.name === 'Install dependencies')
    const nativeIndex = installerSteps.findIndex((step) => step.id === 'native-runtime')
    expect(installIndex).toBeLessThan(nativeIndex)
    const steps = nativeAction.runs.steps
    const cacheIndex = steps.findIndex((step) => step.name === 'Restore compiled native modules')
    const prepareIndex = steps.findIndex((step) => step.name === 'Prepare native runtime')

    // `--ignore-scripts` leaves no build/, so a restore before the install would be
    // overwritten and one after the rebuild would never save a hit.
    expect(cacheIndex).toBeLessThan(prepareIndex)
    expect(steps[cacheIndex].if).toBe(
      "inputs.native-runtime != 'none' && inputs.persist-native-cache != 'false'"
    )
    const restoreOnly = steps.find(
      (step) => step.name === 'Restore compiled native modules without saving'
    )
    expect(restoreOnly.if).toBe(
      "inputs.native-runtime != 'none' && inputs.persist-native-cache == 'false'"
    )
    expect(restoreOnly.uses).toBe('actions/cache/restore@v5')
    // Native artifacts are ABI-bound: a key missing either dimension serves a build
    // that cannot load, and ensure-native-runtime would recompile it anyway.
    for (const cacheStep of [steps[cacheIndex], restoreOnly]) {
      expect(cacheStep.with.key).toBe('${{ steps.native-cache-scope.outputs.key }}')
      expect(cacheStep.with.path).not.toContain('${{')
      expect(cacheStep.with.path).toContain('node-pty@*/node_modules/node-pty/build')
      expect(cacheStep.with.path).toContain('native/windows-registry/build')
      expect(cacheStep.with.path).toContain('@vscode+windows-process-tre*')
      expect(cacheStep.with['restore-keys']).toBeUndefined()
    }
    expect(steps[cacheIndex].id).toBe('native-cache-restore')
    expect(restoreOnly.id).toBe('native-cache-restore-only')
    const cacheScope = steps.find((step) => step.name === 'Resolve native cache scope')
    expect(cacheScope.if).toBe("inputs.native-runtime != 'none'")
    expect(cacheScope.run).toContain('/etc/os-release')
    expect(nativeAction.outputs['cache-scope'].value).toBe(
      '${{ steps.native-cache-scope.outputs.scope }}'
    )
    expect(nativeAction.outputs['cache-hit'].value).toContain(
      'steps.native-cache-restore.outputs.cache-hit'
    )
    expect(nativeAction.outputs['cache-hit'].value).toContain(
      'steps.native-cache-restore-only.outputs.cache-hit'
    )
    for (const output of ['scope', 'hit', 'key', 'path']) {
      expect(dependencyAction.outputs[`native-cache-${output}`].value).toBe(
        `\${{ steps.native-runtime.outputs.cache-${output} }}`
      )
    }
    const electronCache = installerSteps.find(
      (step) => step.name === 'Cache Electron package archive'
    )
    const electronCacheResolution = installerSteps.find(
      (step) => step.name === 'Resolve Electron package cache'
    )
    expect(electronCacheResolution.if).toBe(
      "inputs.native-runtime == 'electron' || inputs.cache-electron-package == 'true'"
    )
    expect(electronCache.if).toBe(
      "(github.event_name != 'pull_request' || runner.os != 'Linux') && steps.electron-package-cache.outputs.version != ''"
    )
    expect(electronCache.uses).toBe('actions/cache@v5')
    expect(electronCache.with.key).toContain('steps.electron-package-cache.outputs.version')
    expect(dependencyAction.inputs['cache-electron-package'].default).toBe('false')
  })

  it('reuses TypeScript incremental state across typecheck runs', () => {
    const steps = workflow.jobs.typecheck.steps
    const cacheIndex = steps.findIndex((step) => step.name === 'Cache TypeScript incremental state')
    const checkIndex = steps.findIndex((step) => step.run === 'pnpm run typecheck')

    expect(cacheIndex).toBeGreaterThanOrEqual(0)
    expect(cacheIndex).toBeLessThan(checkIndex)
    expect(steps[cacheIndex].with.path).toBe('config/*.tsbuildinfo')
    // Why restore-keys matter here: the base SHA key is shared by every commit in a PR,
    // but actions/cache keeps the first successful graph until the base or config changes.
    expect(steps[cacheIndex].with['restore-keys']).toBeTruthy()
    // The buildinfo is only reusable while the compiler options that produced it hold.
    expect(steps[cacheIndex].with.key).toContain(
      "hashFiles('pnpm-lock.yaml', 'config/tsconfig*.json')"
    )
    expect(steps[cacheIndex].with.key).toContain('github.event.pull_request.base.sha')
    expect(steps[cacheIndex].with['restore-keys']).not.toContain('tsbuildinfo-${{ runner.os }}-\n')
  })

  it('checks out full history without historical blobs', () => {
    const fullHistoryCheckouts = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter(
        (step) => step.uses?.startsWith('actions/checkout@') && step.with?.['fetch-depth'] === 0
      )

    expect(fullHistoryCheckouts.length).toBeGreaterThan(0)
    for (const checkout of fullHistoryCheckouts) {
      expect(checkout.with.filter).toBe('blob:none')
    }
  })

  it('keeps advisory unit-selection evidence off the gate', () => {
    // It is continue-on-error, so it can never fail a PR. Living inside unit-tests.yml made a
    // caller's `needs: test` wait for it anyway, holding verify ~36s past the last shard. Pinned
    // here so it cannot drift back onto the critical path.
    const evidence = workflow.jobs.unit_selection_evidence
    expect(evidence.uses).toBe('./.github/workflows/unit-selection-evidence.yml')
    expect(evidence.needs).toEqual(['test'])
    expect(workflow.jobs.verify.needs).not.toContain('unit_selection_evidence')
    expect(unitTestWorkflow.jobs.selection_evidence).toBeUndefined()
    const evidenceWorkflow = parse(
      readFileSync('.github/workflows/unit-selection-evidence.yml', 'utf8')
    )
    const job = evidenceWorkflow.jobs.selection_evidence
    expect(job['continue-on-error']).toBe(true)
  })

  it('keeps verify as the aggregate required check', () => {
    expect(workflow.jobs.verify.needs).toEqual([
      'code_paths',
      'static_analysis',
      'typecheck',
      'git_compatibility',
      'codex_index_heal_contract',
      'xterm_patch_sync',
      'shell_contracts',
      'test',
      'orcad_browser',
      'mobile_web_app',
      'cross-version-wire',
      'managed_hook_node18',
      'package',
      'package_windows'
    ])
    const verifyStep = workflow.jobs.verify.steps.find(
      (step) => step.name === 'Require successful checks'
    )
    expect(verifyStep.env.MANAGED_HOOK_NODE18).toBe('${{ needs.managed_hook_node18.result }}')
    expect(verifyStep.run).toContain('"$MANAGED_HOOK_NODE18"')
    // Why assert this one too: the browser provider test skips itself without
    // ORCA_BROWSER_EXECUTABLE, so it only guards anything if verify actually reads it.
    expect(verifyStep.env.ORCAD_BROWSER).toBe('${{ needs.orcad_browser.result }}')
    expect(verifyStep.run).toContain('"$ORCAD_BROWSER"')
    expect(verifyStep.env.CROSS_VERSION_WIRE).toBe('${{ needs.cross-version-wire.result }}')
    expect(verifyStep.run).toContain('"$CROSS_VERSION_WIRE"')
    // Same reason as the browser provider: the render check fails loudly on a runner with no
    // Chrome, which only guards the page if verify reads the job's result.
    expect(verifyStep.env.MOBILE_WEB_APP).toBe('${{ needs.mobile_web_app.result }}')
    expect(verifyStep.run).toContain('"$MOBILE_WEB_APP"')
  })

  it('makes the mobile_web_app job refuse to skip the tests it exists to run', () => {
    // The bundling tests skip themselves without mobile/node_modules, which is what keeps the
    // sharded `test` job green. Only this env var stops that skip from spreading to the one job
    // that installs them, so a typo here would leave the whole job passing vacuously.
    const step = workflow.jobs.mobile_web_app.steps.find(
      (entry) => entry.name === 'Builder, override census and render checks'
    )
    expect(step.run).toContain('node config/scripts/run-mobile-web-app-checks.mjs')
    expect(step.run).not.toContain('--prepare-route-snapshot')
    expect(step.env[MOBILE_WEB_APP_DEPENDENCIES_REQUIRED_ENV]).toBe('1')
  })
})
