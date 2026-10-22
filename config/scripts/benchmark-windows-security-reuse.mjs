import assert from 'node:assert/strict'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { runProcess, runProcessSync } from '@orca/process-host'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'
import {
  buildWindowsSecurityAddon,
  probeWindowsSecurityAddon
} from './build-windows-security-addon.mjs'
import { assertNoHeaderDownloads, treeDigest } from './benchmark-windows-native-preparation.mjs'
import { ensurePinnedNodeExecutable, preparePinnedNodeDir } from './pinned-node-downloads.mjs'
import { sha256Of } from './orcad-prebuild-slot-contents.mjs'
import { hash } from './windows-native-benchmark-observer.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const { PE_MACHINE, readPeMachine } = createRequire(import.meta.url)('./windows-pe-machine.cjs')
const invalidCandidate = Buffer.from('orca-windows-security-qualification-invalid')
const preparedPath = (root) =>
  join(root, 'native/windows-security/build/Release/orca_windows_security.node')

export function assertSecurityComparisonHost({
  platform = process.platform,
  arch = process.arch,
  version = process.versions.node,
  electron = process.versions.electron,
  sourceSha = process.env.SOURCE_SHA,
  runner = process.env.BENCHMARK_RUNNER
} = {}) {
  assert.equal(platform, 'win32', 'Security comparison requires Windows')
  assert(!electron, 'Security comparison requires plain Node')
  assert.equal(
    { 'windows-2022': 'x64', 'windows-11-arm': 'arm64' }[runner],
    arch,
    'Runner architecture mismatch'
  )
  assert(['x64', 'arm64'].includes(arch), 'Unsupported architecture')
  assert.equal(version, NODE_RUNTIME_PIN.version, 'Build Node differs from pin')
  assert(/^[0-9a-f]{40}$/.test(sourceSha ?? ''), 'SOURCE_SHA must be exact')
}

export function assertSecurityCommand(result) {
  assert(
    result.code === 0 && !result.signal && !result.timedOut && !result.outputTruncated,
    'Command failed or produced incomplete output'
  )
}

export function probeSecurityArtifact(
  path,
  runtimePath,
  arch,
  run = runProcessSync,
  runtimeAssets = NODE_RUNTIME_ASSETS
) {
  const machine = readPeMachine(path)
  assert.equal(machine, PE_MACHINE[arch], 'Security artifact architecture mismatch')
  const sha256 = sha256Of(path)
  assert.equal(
    sha256Of(runtimePath),
    runtimeAssets[`win32-${arch}`]?.executableSha256,
    'Runtime hash mismatch'
  )
  const result = probeWindowsSecurityAddon(runtimePath, resolve(path), arch, run)
  assertSecurityCommand(result)
  assert.equal(result.stdout, 'windows-security-ready', 'Security operation failed')
  assert.equal(sha256Of(path), sha256, 'Security artifact changed during probe')
  return { sha256, machine, currentUserSid: 'passed' }
}

export async function withInvalidSecurityCandidate(candidate, backupDir, expectedHash, action) {
  const stat = lstatSync(candidate)
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Candidate must be an owned regular file')
  assert.equal(sha256Of(candidate), expectedHash, 'Prepared candidate changed before backup')
  const backup = join(backupDir, 'prepared-security-backup.node')
  writeFileSync(backup, readFileSync(candidate), { flag: 'wx', mode: 0o600 })
  assert.equal(sha256Of(backup), expectedHash, 'Candidate backup mismatch')
  try {
    writeFileSync(candidate, invalidCandidate)
    assert.equal(sha256Of(candidate), hash(invalidCandidate), 'Invalidation failed')
    return await action()
  } finally {
    copyFileSync(backup, candidate)
    chmodSync(candidate, stat.mode)
    assert.equal(sha256Of(candidate), expectedHash, 'Candidate restoration failed')
    utimesSync(candidate, stat.atimeMs / 1000, stat.mtimeMs / 1000)
  }
}

export function runSecurityComparisonSample({
  root = ROOT,
  variant,
  arch = process.arch,
  runtimePath,
  output,
  receiptFile,
  run = runProcessSync,
  runtimeAssets = NODE_RUNTIME_ASSETS
}) {
  assert(['control', 'candidate', 'fallback'].includes(variant), 'Unknown sample')
  const receipt = { variant, qualification: 'incomplete', stage: 'initial-validation', calls: [] }
  const save = () => writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
  const observed = (spec) => {
    const phase = spec.args?.includes('rebuild')
      ? 'compiler'
      : spec.args?.includes('--check-only')
        ? 'preparation-probe'
        : 'security-probe'
    const started = performance.now()
    const call = { phase, complete: false }
    receipt.stage = phase
    receipt.calls.push(call)
    try {
      const result = run({
        ...spec,
        stdio: 'pipe',
        timeoutMs: spec.timeoutMs ?? 480_000,
        maxOutputBytes: 64 * 1024 * 1024
      })
      Object.assign(call, {
        code: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
        stdoutSha256: hash(result.stdout),
        stderrSha256: hash(result.stderr)
      })
      assertSecurityCommand(result)
      assertNoHeaderDownloads(result)
      call.complete = true
      return result
    } finally {
      call.durationMs = performance.now() - started
      save()
    }
  }
  try {
    assert.equal(arch, process.arch, 'Sample architecture differs from host')
    assert.equal(
      sha256Of(runtimePath),
      runtimeAssets[`win32-${arch}`]?.executableSha256,
      'Runtime hash mismatch'
    )
    receipt.stage = 'build'
    const start = performance.now()
    buildWindowsSecurityAddon(arch, output, {
      root,
      run: observed,
      enabled: variant !== 'control',
      runtimePath,
      runtimeAssets
    })
    receipt.buildIncludingReuseProbesMs = performance.now() - start
    receipt.staged = probeSecurityArtifact(output, runtimePath, arch, observed, runtimeAssets)
    receipt.compilerInvocationCount = receipt.calls.filter(
      (call) => call.phase === 'compiler'
    ).length
    receipt.stage = 'validate-observations'
    receipt.compilerCountMeaning =
      'Actual node-gyp rebuild subprocess calls; each uses the builder fresh work directory.'
    assert.equal(
      receipt.compilerInvocationCount,
      variant === 'candidate' ? 0 : 1,
      'Unexpected compiler invocation count'
    )
    assert(
      receipt.calls.every((call) => call.complete),
      'A rejected/incomplete command was hidden by fallback'
    )
    receipt.qualification = 'passed'
    return receipt
  } catch {
    receipt.qualification = 'failed'
    receipt.failureStage = receipt.stage
    throw new Error('Windows security sample did not qualify')
  } finally {
    receipt.compilerInvocationCount = receipt.calls.filter(
      (call) => call.phase === 'compiler'
    ).length
    save()
  }
}

export async function benchmarkWindowsSecurityReuse(
  root = ROOT,
  {
    run = runProcess,
    runSync = runProcessSync,
    ensureRuntime = ensurePinnedNodeExecutable,
    prepareHeaders = preparePinnedNodeDir,
    runtimeAssets = NODE_RUNTIME_ASSETS,
    hashFile = sha256Of
  } = {}
) {
  assertSecurityComparisonHost()
  const arch = process.arch
  const target = `win32-${arch}`
  const output = join(root, '.build/windows-native-benchmark/security')
  mkdirSync(output, { recursive: true })
  const temporary = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), 'orca-security-comparison-')
  )
  const report = {
    schemaVersion: 1,
    qualification: 'incomplete',
    startedAt: new Date().toISOString(),
    phases: [],
    samples: [],
    scope:
      'One same-run warm control/candidate pair and one invalid-candidate fallback; no CI occupancy or cache-hit-rate claim.',
    sourceSha: process.env.SOURCE_SHA,
    arch,
    runner: process.env.BENCHMARK_RUNNER,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    preparation:
      'Source-built in this run; no native cache restore. Headers and runtime preparation precede all measured samples.'
  }
  const save = () =>
    writeFileSync(join(output, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`)
  let environment = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  const command = async (label, program, args) => {
    report.stage = label
    const start = performance.now()
    const result = await run({
      program,
      args,
      cwd: root,
      env: environment,
      timeoutMs: 1_200_000,
      maxOutputBytes: 64 * 1024 * 1024,
      terminationBarrier: true
    })
    report.phases.push({
      label,
      durationMs: performance.now() - start,
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      stdoutSha256: hash(result.stdout),
      stderrSha256: hash(result.stderr)
    })
    save()
    assertSecurityCommand(result)
    return result
  }
  const sourceCheck = async () => {
    const head = await command('source-head', 'git', ['rev-parse', 'HEAD'])
    assert.equal(head.stdout.trim(), process.env.SOURCE_SHA, 'Source commit mismatch')
    await command('source-clean', 'git', ['diff', '--exit-code', 'HEAD', '--'])
    const untracked = await command('source-untracked', 'git', [
      'ls-files',
      '--others',
      '--exclude-standard'
    ])
    assert.equal(untracked.stdout, '', 'Untracked source prevents exact comparison')
  }
  try {
    await sourceCheck()
    report.stage = 'verify-build-node'
    assert.equal(
      hashFile(process.execPath),
      runtimeAssets[target].executableSha256,
      'Build Node hash mismatch'
    )
    const sourceFiles = (
      await command('security-source-files', 'git', ['ls-files', '--', 'native/windows-security'])
    ).stdout
      .trim()
      .split(/\r?\n/)
    const identityFiles = [
      ...sourceFiles,
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      '.github/actions/prepare-native-runtime/action.yml',
      'src/shared/node-runtime-pin.ts',
      'config/scripts/build-windows-security-addon.mjs',
      'config/scripts/ensure-native-runtime.mjs',
      'config/scripts/benchmark-windows-security-reuse.mjs'
    ]
    report.sourceHashes = Object.fromEntries(
      identityFiles.map((path) => [path, sha256Of(join(root, path))])
    )
    report.sourceInputsSha256 = hash(JSON.stringify(report.sourceHashes))
    report.tree = (await command('source-tree', 'git', ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    // This mode owns the candidate because its preparation creates it in a fresh checkout.
    const candidate = preparedPath(root)
    report.stage = 'verify-fresh-checkout'
    assert(!existsSync(candidate), 'Security comparison requires a fresh unprepared checkout')
    report.stage = 'prepare-pinned-runtime-and-headers'
    const preparationStart = performance.now()
    const runtimePath = await ensureRuntime({ target })
    const nodeDir = await prepareHeaders({ target, workDir: join(temporary, 'headers') })
    environment = {
      ...environment,
      npm_config_nodedir: nodeDir,
      npm_package_config_node_gyp_nodedir: nodeDir
    }
    report.downloadAndHeaderPreparationMs = performance.now() - preparationStart
    report.runtime = {
      version: NODE_RUNTIME_PIN.version,
      sha256: sha256Of(runtimePath),
      buildNodeSha256: hashFile(process.execPath)
    }
    report.headers = treeDigest(nodeDir)
    await command('prepare-node-artifacts', process.execPath, [
      join(root, 'config/scripts/initialize-windows-native-toolchain.mjs')
    ])
    await command('verify-prepared-node', process.execPath, [
      join(root, 'config/scripts/ensure-native-runtime.mjs'),
      '--check-only'
    ])
    report.stage = 'verify-prepared-candidate-ownership'
    assert.equal(
      realpathSync(candidate).toLowerCase(),
      preparedPath(realpathSync(root)).toLowerCase(),
      'Candidate escapes owned checkout'
    )
    assert(
      lstatSync(candidate).isFile() && !lstatSync(candidate).isSymbolicLink(),
      'Prepared candidate must be regular'
    )
    report.prepared = probeSecurityArtifact(candidate, runtimePath, arch, runSync, runtimeAssets)
    const sample = async (variant) => {
      await sourceCheck()
      const receiptFile = join(output, `${variant}.json`)
      const result = await command(`${variant}-full-build-and-probe`, process.execPath, [
        import.meta.filename,
        `--sample=${variant}`,
        runtimePath,
        join(output, `${variant}.node`),
        receiptFile
      ])
      assertNoHeaderDownloads(result)
      const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'))
      assert.equal(receipt.qualification, 'passed', 'Sample did not qualify')
      assert.deepEqual(
        treeDigest(nodeDir),
        report.headers,
        'Measured build changed prepared headers'
      )
      if (variant === 'candidate') {
        assert.equal(
          receipt.staged.sha256,
          report.prepared.sha256,
          'Reuse did not copy prepared bytes'
        )
      }
      report.samples.push({ ...receipt, fullCommandMs: report.phases.at(-1).durationMs })
      save()
      await sourceCheck()
    }
    // Warm compiler discovery and local build inputs before measuring the pair.
    await command('warm-compiler-before-measurement', process.execPath, [
      join(root, 'config/scripts/build-windows-security-addon.mjs'),
      `--arch=${arch}`
    ])
    await sample('control')
    await sample('candidate')
    assert.equal(
      sha256Of(candidate),
      report.prepared.sha256,
      'Prepared candidate changed during pair'
    )
    report.stage = 'invalidate-owned-candidate'
    await withInvalidSecurityCandidate(candidate, output, report.prepared.sha256, async () => {
      report.invalidCandidateSha256 = sha256Of(candidate)
      await sample('fallback')
    })
    report.restoredPreparedSha256 = sha256Of(candidate)
    assert.equal(
      report.restoredPreparedSha256,
      report.prepared.sha256,
      'Prepared bytes were not restored'
    )
    await sourceCheck()
    const [control, candidateSample] = report.samples
    report.comparison = {
      controlMs: control.fullCommandMs,
      candidateMs: candidateSample.fullCommandMs,
      candidateMinusControlMs: candidateSample.fullCommandMs - control.fullCommandMs,
      limitation:
        'One fixed-order same-run pair per architecture; descriptive only, not a significance or job-time estimate.'
    }
    report.qualification = 'passed'
  } catch {
    report.qualification = 'failed'
    report.failureStage = report.stage
    throw new Error('Windows security comparison did not qualify')
  } finally {
    report.finishedAt = new Date().toISOString()
    report.restored = report.prepared
      ? existsSync(preparedPath(root)) && sha256Of(preparedPath(root)) === report.prepared.sha256
      : null
    save()
    rmSync(temporary, { recursive: true, force: true })
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const variant = process.argv
      .find((arg) => arg.startsWith('--sample='))
      ?.slice('--sample='.length)
    if (variant) {
      assertSecurityComparisonHost()
      runSecurityComparisonSample({
        variant,
        runtimePath: process.argv[3],
        output: process.argv[4],
        receiptFile: process.argv[5]
      })
    } else {
      await benchmarkWindowsSecurityReuse()
    }
  } catch {
    console.error('[windows-security-comparison] failed; inspect the redacted receipt')
    process.exitCode = 1
  }
}
