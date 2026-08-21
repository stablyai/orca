import { globSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const dependencyAction = parse(
  readFileSync('.github/actions/install-node-dependencies/action.yml', 'utf8')
)
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const shellContractFiles = [
  'src/main/daemon/repro-13767-shell-ready-marker-lost-to-exec.test.ts',
  'src/main/daemon/shell-ready.test.ts',
  'src/main/providers/local-pty-shell-ready-zsh-launch-environment.test.ts',
  'src/main/providers/__tests__/shell-ready-framework-example.test.ts',
  'src/main/shell-startup-feature-channel.test.ts',
  'src/main/zsh-scoped-histfile.live-shell.test.ts',
  'src/main/zsh-startup-hook-user-config-equivalence.live-shell.test.ts',
  'src/main/zsh-wrapper-version-mismatch.live-shell.test.ts',
  'src/shared/posix-command-path-lookup.test.ts'
]
const patchedNodePtyContractFiles = [
  'src/main/daemon/node-pty-fd-leak.test.ts',
  'src/main/pty/omp-shell-wrapper.node-pty.test.ts',
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
  /(?:spawnSync|execFileSync|spawn)\(\s*['"](?:\/(?:usr\/)?bin\/)?zsh['"]|spawnSync\(\s*['"]which['"]\s*,\s*\[\s*['"]zsh['"]|name:\s*['"]zsh['"]\s*,\s*path:\s*executablePath|from '[^']*zsh-startup-hook-pty-harness'/

describe('PR workflow parallelism', () => {
  it('cancels superseded runs for the same pull request', () => {
    expect(workflow.concurrency.group).toBe('pr-checks-${{ github.event.pull_request.number }}')
    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
  })

  it('grants the PR workflow read-only repository access', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('shards the general test suite across Node 24 and Node 26', () => {
    expect(workflow.jobs.test.strategy.matrix.node).toEqual(['24', '26'])
    expect(workflow.jobs.test.strategy.matrix.shard).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1)
    )
    expect(workflow.jobs.test.strategy.matrix.shard_total).toEqual([16])
    const testStep = workflow.jobs.test.steps.find((step) => step.name === 'Test shard')
    const installStep = workflow.jobs.test.steps.find(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )

    expect(installStep.with['node-version']).toBe('${{ matrix.node }}')
    expect(testStep.run).toContain('--shard=${{ matrix.shard }}/${{ matrix.shard_total }}')
    for (const testFile of nativeShellContractFiles) {
      expect(testStep.run).toContain(`--exclude=${testFile}`)
    }
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
    const jobsInstallingPackages = Object.entries(workflow.jobs)
      .filter(([, job]) => (job.steps ?? []).some((step) => aptPackages(step).length > 0))
      .map(([name]) => name)

    expect(shellStep).toBeDefined()
    expect(shellInstall).toBeDefined()
    expect(shellStep.run.split(/\s+/)).toContain('--maxWorkers=1')
    // Why the whole workflow, not just the general shards: any other lane installing
    // these shells would silently start running the real-shell tests twice.
    expect(jobsInstallingPackages).toEqual(['shell_contracts'])
    // Why each shell is asserted: the live tests skip themselves when the binary is
    // missing, so a dropped package silently empties this lane instead of failing it.
    const shellPackages = workflow.jobs.shell_contracts.steps.flatMap(aptPackages)
    for (const shell of ['zsh', 'fish']) {
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
    expect(steps[nodeIndex].with.cache).toBe('pnpm')
    expect(steps[nodeIndex].if).toBe("inputs.node-version == ''")
    expect(steps[requestedNodeIndex].if).toBe("inputs.node-version != ''")
    expect(steps[requestedNodeIndex].with['node-version']).toBe('${{ inputs.node-version }}')
    expect(steps[requestedNodeIndex].with.cache).toBe('pnpm')
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

    for (const jobName of [
      'static_analysis',
      'typecheck',
      'git_compatibility',
      'xterm_patch_sync'
    ]) {
      expect(installFor(jobName).with, jobName).toBeUndefined()
    }
    expect(installFor('shell_contracts').with['native-runtime']).toBe('node')
    expect(installFor('test').with['native-runtime']).toBe('node')
    expect(installFor('package').with['native-runtime']).toBe('electron')

    expect(
      dependencyAction.runs.steps.find((step) => step.name === 'Use external node-gyp').if
    ).toBe("inputs.native-runtime != 'none'")
    const dependencyInstall = dependencyAction.runs.steps.find(
      (step) => step.name === 'Install dependencies'
    )
    // Why frozen: re-resolving the graph costs a minute per job and the `git diff`
    // guard below already fails the run when the lockfile is stale, so the slow
    // resolution can never legitimately change anything.
    expect(dependencyInstall.run).toContain('--frozen-lockfile')
    expect(dependencyInstall.run).not.toContain('--no-frozen-lockfile')
    expect(dependencyInstall.run).toContain('git diff --exit-code package.json pnpm-lock.yaml')
    expect(dependencyInstall.run).toContain('--ignore-scripts')
    expect(dependencyInstall.run).not.toContain('--os=')
    expect(dependencyInstall.run).not.toContain('--cpu=')
    expect(packageJson.pnpm.supportedArchitectures.os).toEqual(
      expect.arrayContaining(['current', 'win32'])
    )
    expect(packageJson.pnpm.supportedArchitectures.cpu).toContain('current')
    const prepareRuntime = dependencyAction.runs.steps.find(
      (step) => step.name === 'Prepare native runtime'
    )
    expect(prepareRuntime.if).toBe("inputs.native-runtime != 'none'")
    expect(prepareRuntime.run).toContain('ensure-native-runtime.mjs --runtime="$NATIVE_RUNTIME"')
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
    const steps = dependencyAction.runs.steps
    const installIndex = steps.findIndex((step) => step.name === 'Install dependencies')
    const cacheIndex = steps.findIndex((step) => step.name === 'Restore compiled native modules')
    const prepareIndex = steps.findIndex((step) => step.name === 'Prepare native runtime')

    // `--ignore-scripts` leaves no build/, so a restore before the install would be
    // overwritten and one after the rebuild would never save a hit.
    expect(installIndex).toBeLessThan(cacheIndex)
    expect(cacheIndex).toBeLessThan(prepareIndex)
    expect(steps[cacheIndex].if).toBe("inputs.native-runtime != 'none'")
    // Native artifacts are ABI-bound: a key missing either dimension serves a build
    // that cannot load, and ensure-native-runtime would recompile it anyway.
    expect(steps[cacheIndex].with.key).toContain('${{ inputs.native-runtime }}')
    expect(steps[cacheIndex].with.key).toContain('steps.requested-node.outputs.node-version')
    expect(steps[cacheIndex].with.key).toContain('config/patches/node-pty@1.1.0.patch')
    // No restore-keys: a partial-match key is exactly the ABI-mismatched build above.
    expect(steps[cacheIndex].with['restore-keys']).toBeUndefined()
  })

  it('reuses TypeScript incremental state across typecheck runs', () => {
    const steps = workflow.jobs.typecheck.steps
    const cacheIndex = steps.findIndex((step) => step.name === 'Cache TypeScript incremental state')
    const checkIndex = steps.findIndex((step) => step.run === 'pnpm run typecheck')

    expect(cacheIndex).toBeGreaterThanOrEqual(0)
    expect(cacheIndex).toBeLessThan(checkIndex)
    expect(steps[cacheIndex].with.path).toBe('config/*.tsbuildinfo')
    // Why restore-keys matter here: an exact-key miss is the normal case (the key is
    // per-SHA), so without them the cache would never once be read.
    expect(steps[cacheIndex].with['restore-keys']).toBeTruthy()
    // The buildinfo is only reusable while the compiler options that produced it hold.
    expect(steps[cacheIndex].with.key).toContain(
      "hashFiles('pnpm-lock.yaml', 'config/tsconfig*.json')"
    )
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

  it('keeps verify as the aggregate required check', () => {
    expect(workflow.jobs.verify.needs).toEqual([
      'code_paths',
      'static_analysis',
      'root_directory_guard',
      'typecheck',
      'git_compatibility',
      'xterm_patch_sync',
      'shell_contracts',
      'test',
      'managed_hook_node18',
      'package',
      'package_windows'
    ])
    const verifyStep = workflow.jobs.verify.steps.find(
      (step) => step.name === 'Require successful checks'
    )
    expect(verifyStep.env.MANAGED_HOOK_NODE18).toBe('${{ needs.managed_hook_node18.result }}')
    expect(verifyStep.run).toContain('"$MANAGED_HOOK_NODE18"')
  })
})
