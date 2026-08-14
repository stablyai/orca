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
  'src/main/providers/local-pty-shell-ready.test.ts',
  'src/main/providers/__tests__/shell-ready-framework-example.test.ts',
  'src/shared/posix-command-path-lookup.test.ts'
]
const patchedNodePtyContractFiles = [
  'src/main/daemon/node-pty-fd-leak.test.ts',
  'src/main/pty/omp-shell-wrapper.node-pty.test.ts'
]
const nativeShellContractFiles = [...shellContractFiles, ...patchedNodePtyContractFiles]
const testFilePatterns = [
  'config/**/*.{test,spec}.{js,cjs,mjs,ts,tsx}',
  'src/**/*.{test,spec}.{js,cjs,mjs,ts,tsx}',
  'tests/**/*.{test,spec}.{js,cjs,mjs,ts,tsx}',
  'tests/tools/**/*.{test,spec}.{js,cjs,mjs,ts,tsx}'
]
const realZshUsage =
  /(?:spawnSync|execFileSync|spawn)\(\s*['"](?:\/(?:usr\/)?bin\/)?zsh['"]|spawnSync\(\s*['"]which['"]\s*,\s*\[\s*['"]zsh['"]|name:\s*['"]zsh['"]\s*,\s*path:\s*executablePath/

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

  it('keeps every real-zsh test in the dedicated shell lane', () => {
    const discoveredFiles = globSync(testFilePatterns)
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

    for (const jobName of ['static_analysis', 'typecheck', 'git_compatibility']) {
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
    expect(dependencyInstall.run).toContain('--no-frozen-lockfile')
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

  it('keeps verify as the aggregate required check', () => {
    expect(workflow.jobs.verify.needs).toEqual([
      'static_analysis',
      'root_directory_guard',
      'typecheck',
      'git_compatibility',
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
