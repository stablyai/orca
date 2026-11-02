import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'
import { hasWindowsCompilerSelection } from './initialize-windows-native-toolchain.mjs'
import {
  compilerEnvironmentKey,
  environmentReceipt,
  hash
} from './windows-native-benchmark-observer.mjs'

const addonNames = [
  'node-pty',
  '@orca/windows-registry',
  '@orca/windows-security',
  '@vscode/windows-process-tree'
]
const candidate = 'initialize-windows-native-toolchain.mjs'
const control = 'ensure-native-runtime.mjs'
const unchangedFiles = [
  `.github/actions/prepare-native-runtime/action.yml`,
  `config/scripts/${control}`,
  `config/scripts/${candidate}`,
  'config/scripts/capture-windows-native-environment.cmd',
  'config/scripts/windows-native-benchmark-observer.mjs',
  'config/scripts/benchmark-windows-native-preparation.mjs'
]

export function validateObservedPreparation(receipt, variant, warm = false) {
  assert.equal(
    receipt.parentBefore.hash,
    receipt.parentAfter.hash,
    'Outer compiler environment changed'
  )
  const calls = (phase) => receipt.calls.filter((call) => call.phase === phase)
  const captured = variant !== 'control' && !warm
  assert.equal(calls('discovery').length, captured ? 1 : 0, 'Unexpected compiler discovery count')
  assert.equal(calls('capture').length, captured ? 1 : 0, 'Unexpected developer command count')
  assert.equal(
    calls('probe').length,
    variant === 'control' ? 0 : 1,
    'Missing helper preflight observation'
  )
  for (const call of receipt.calls) {
    assert(
      !call.error && !call.timedOut && !call.outputTruncated,
      'Incomplete compiler observation'
    )
  }
  if (variant === 'control') {
    assert.equal(calls('addon-build').length, warm ? 0 : 4, 'Expected all four cold addon builds')
    assert(
      receipt.calls.every((call) => call.code === 0),
      'Control preparation failed'
    )
    return
  }
  const [prepare] = calls('preparation')
  assert.equal(calls('preparation').length, 1, 'Missing unchanged preparation child')
  assert.equal(prepare.code, 0, 'Native preparation failed')
  assert.equal(calls('probe')[0].code, warm ? 0 : 1, 'Unexpected helper cold/warm probe')
  if (warm || variant === 'fallback') {
    assert.equal(
      prepare.environment.hash,
      receipt.parentBefore.hash,
      'Fallback/warm changed compiler selection'
    )
    assert.deepEqual(prepare.changedNames, [], 'Fallback/warm altered child environment')
  } else {
    assert.equal(calls('discovery')[0].code, 0)
    assert.equal(calls('capture')[0].code, 0)
    assert(prepare.changedNames.length > 0, 'Captured environment was not applied')
    assert(
      prepare.changedNames.every((name) => compilerEnvironmentKey.test(name)),
      'Unrelated environment changed'
    )
    assert(prepare.environment.compiler.vcinstalldir, 'Prepared child lacks compiler selection')
  }
  if (variant === 'fallback' && !warm) {
    assert.equal(calls('discovery')[0].code, 0)
    assert.equal(calls('capture')[0].code, 7, 'Fixed failure fixture did not run')
  }
}

export function assertNativeColdProbe(result) {
  assert.equal(result.code, 1, 'Cold fixture unexpectedly passed')
  for (const name of addonNames) {
    assert(result.stderr.includes(`${name}:`), `Cold fixture did not fail ${name}`)
  }
}

export function assertNoHeaderDownloads(result) {
  assert(
    !/gyp http (GET|200|download)/i.test(`${result.stdout}\n${result.stderr}`),
    'Timed preparation downloaded headers/libraries'
  )
}

function digestFiles(root, paths) {
  return Object.fromEntries(
    paths
      .filter((path) => existsSync(join(root, path)))
      .map((path) => [path, hash(readFileSync(join(root, path)))])
  )
}

export function treeDigest(root) {
  const digest = createHash('sha256')
  const files = []
  const visit = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name)
      if (statSync(child).isDirectory()) {
        visit(child)
      } else {
        files.push(child)
      }
    }
  }
  visit(root)
  for (const file of files) {
    digest.update(relative(root, file)).update('\0').update(readFileSync(file))
  }
  return { sha256: digest.digest('hex'), files: files.length }
}

function nativeDirectories(snapshot) {
  const require = createRequire(join(snapshot, 'package.json'))
  const root = realpathSync(snapshot)
  return addonNames.map((name) => {
    const directory = realpathSync(dirname(require.resolve(`${name}/package.json`)))
    assert(directory.startsWith(`${root}${sep}`), `Addon escapes its isolated copy: ${name}`)
    return { name, directory }
  })
}

function binaryReceipt(snapshot) {
  const require = createRequire(join(snapshot, 'package.json'))
  const paths = [
    join(dirname(require.resolve('node-pty/package.json')), 'build/Release/conpty.node'),
    join(dirname(require.resolve('node-pty/package.json')), 'build/Release/conpty/conpty.dll'),
    join(dirname(require.resolve('node-pty/package.json')), 'build/Release/conpty/OpenConsole.exe'),
    join(snapshot, 'native/windows-registry/build/Release/orca_windows_registry.node'),
    join(snapshot, 'native/windows-security/build/Release/orca_windows_security.node'),
    join(
      dirname(require.resolve('@vscode/windows-process-tree/package.json')),
      'build/Release/windows_process_tree.node'
    )
  ]
  return paths.map((path) => {
    assert(existsSync(path), `Missing prepared artifact: ${path}`)
    return {
      path: relative(snapshot, path),
      bytes: statSync(path).size,
      sha256: hash(readFileSync(path))
    }
  })
}

export async function benchmarkWindowsNativePreparation(
  root = resolve(import.meta.dirname, '../..')
) {
  assert.equal(process.platform, 'win32', 'This hosted comparison requires Windows')
  assert(['x64', 'arm64'].includes(process.arch), 'Unsupported Windows runner')
  assert.equal(process.versions.node, '24.21.0', 'Comparison requires pinned Node')
  assert(
    !hasWindowsCompilerSelection(process.env),
    'Explicit compiler selection prevents a qualified automatic-capture comparison'
  )
  assert(/^[0-9a-f]{40}$/.test(process.env.SOURCE_SHA ?? ''), 'SOURCE_SHA must be an exact commit')
  const output = join(root, '.build/windows-native-benchmark')
  mkdirSync(output, { recursive: true })
  const temporary = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), 'orca-native-comparison-')
  )
  const archive = join(temporary, 'source.tar')
  const headers = join(temporary, 'headers')
  const pnpm = resolvePnpmCliInvocation()
  const environment = {
    ...process.env,
    ORCA_BACKGROUND_LAUNCH: '1',
    npm_config_devdir: headers,
    npm_package_config_node_gyp_devdir: headers
  }
  const parentBefore = environmentReceipt(process.env)
  const githubEnvironmentBefore = existsSync(process.env.GITHUB_ENV ?? '')
    ? hash(readFileSync(process.env.GITHUB_ENV))
    : null
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    qualification: 'incomplete',
    firstRecordedJobStep: JSON.parse(readFileSync(join(output, 'job-start.json'), 'utf8')),
    phases: [],
    samples: [],
    scope: {
      warm: 'Same-build warm preparation; no Actions native-cache restore/save is performed.',
      metric:
        'Cold addon preparation with identical diagnostic preload; installs, header downloads, standalone qualification probes and artifact upload are recorded separately; the helper preflight remains included.',
      occupancy:
        'Use complete hosted job started_at/completed_at, including setup and upload/post steps, for actual runner occupancy. This artifact only measures its explicit window.',
      excluded:
        'No Node-to-Electron, cross-target template, exact-key restore, or CI workload gain is claimed.'
    }
  }
  const writeReport = () =>
    writeFileSync(join(output, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`)
  const command = async (label, program, args, cwd = root, env = environment, accepted = [0]) => {
    const startedAt = new Date().toISOString()
    const start = performance.now()
    const result = await runProcess({
      program,
      args,
      cwd,
      env,
      timeoutMs: 1_200_000,
      maxOutputBytes: 64 * 1024 * 1024,
      terminationBarrier: true
    })
    const elapsedMs = performance.now() - start
    const stdoutFile = `${label}.stdout.log`
    const stderrFile = `${label}.stderr.log`
    writeFileSync(join(output, stdoutFile), result.stdout)
    writeFileSync(join(output, stderrFile), result.stderr)
    report.phases.push({
      label,
      program,
      args,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: elapsedMs,
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      stdoutFile,
      stderrFile,
      stdoutSha256: hash(result.stdout),
      stderrSha256: hash(result.stderr)
    })
    writeReport()
    assert(
      !result.timedOut &&
        !result.signal &&
        !result.outputTruncated &&
        accepted.includes(result.code),
      `${label} failed: ${result.stderr.slice(-4000)}`
    )
    return { ...result, durationMs: elapsedMs }
  }
  const pnpmCommand = (label, args, cwd) =>
    command(label, pnpm.command, [...pnpm.prefixArgs, ...args], cwd)
  try {
    const head = (await command('source-head', 'git', ['rev-parse', 'HEAD'])).stdout.trim()
    assert.equal(head, process.env.SOURCE_SHA, 'Checkout differs from frozen source')
    await command('source-clean', 'git', ['diff', '--exit-code', 'HEAD', '--'])
    const tree = (await command('source-tree', 'git', ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const pnpmVersion = (await pnpmCommand('pnpm-version', ['--version'], root)).stdout.trim()
    assert.equal(pnpmVersion, '12.8.1', 'Comparison requires pinned pnpm')
    const action = readFileSync(
      join(root, '.github/actions/prepare-native-runtime/action.yml'),
      'utf8'
    )
    const hashExpression = action.match(/NATIVE_SOURCE_HASH: (.+)/)?.[1]
    assert(hashExpression, 'Missing production source identity')
    const inputs = [...hashExpression.matchAll(/'([^']+)'/g)].map((match) => match[1])
    assert(
      inputs.includes(`config/scripts/${candidate}`),
      'Frozen source lacks the candidate native-cache fingerprint'
    )
    const requiredScriptHashes = digestFiles(root, unchangedFiles)
    assert.equal(
      Object.keys(requiredScriptHashes).length,
      unchangedFiles.length,
      'Frozen source lacks required scripts'
    )
    const sourceInputs = digestFiles(root, inputs)
    report.identity = {
      sourceSha: head,
      tree,
      runtime: 'node',
      node: process.versions.node,
      nodeAbi: process.versions.modules,
      arch: process.arch,
      pnpm: pnpmVersion,
      runner: process.env.BENCHMARK_RUNNER,
      imageOS: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      sourceInputs,
      requiredScriptHashes,
      sourceInputDigest: hash(JSON.stringify(sourceInputs)),
      productionHashExpression: hashExpression,
      parentCompilerEnvironment: parentBefore.compiler
    }
    await command('archive-source', 'git', ['archive', '--format=tar', '--output', archive, 'HEAD'])
    report.identity.archiveSha256 = hash(readFileSync(archive))
    const require = createRequire(join(root, 'package.json'))
    const nodeGyp = process.env.npm_config_node_gyp || require.resolve('node-gyp/bin/node-gyp.js')
    report.identity.nodeGyp = JSON.parse(
      readFileSync(resolve(dirname(nodeGyp), '..', 'package.json'), 'utf8')
    ).version
    report.identity.nodeGypEntrySha256 = hash(readFileSync(nodeGyp))
    await command('download-headers-before-measurement', process.execPath, [
      nodeGyp,
      'install',
      `--target=${process.versions.node}`,
      `--arch=${process.arch}`,
      `--devdir=${headers}`
    ])
    const headersBefore = treeDigest(headers)
    report.identity.headers = headersBefore
    const physicalDirectories = new Set()
    const schedule = buildCounterbalancedSchedule(2, 'control', 'candidate').flat()
    report.schedule = schedule
    for (const [index, variant] of [...schedule, 'fallback'].entries()) {
      const label = `sample-${String(index + 1).padStart(2, '0')}`
      const snapshot = join(temporary, label)
      mkdirSync(snapshot)
      await command(`${label}-extract`, 'tar', ['-xf', archive, '-C', snapshot])
      await pnpmCommand(
        `${label}-install`,
        [
          'install',
          '--offline',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--package-import-method=copy',
          '--side-effects-cache=false'
        ],
        snapshot
      )
      await pnpmCommand(`${label}-internal-packages`, ['run', 'build:packages'], snapshot)
      const directories = nativeDirectories(snapshot)
      for (const { directory } of directories) {
        assert(
          !physicalDirectories.has(directory.toLowerCase()),
          'Native copies share a build directory'
        )
        physicalDirectories.add(directory.toLowerCase())
        rmSync(join(directory, 'build'), { recursive: true, force: true })
      }
      const initial = await command(
        `${label}-cold-probe`,
        process.execPath,
        [join(snapshot, 'config/scripts', control), '--check-only'],
        snapshot,
        environment,
        [1]
      )
      assertNativeColdProbe(initial)
      const snapshotScriptHashes = digestFiles(snapshot, unchangedFiles)
      assert.deepEqual(
        snapshotScriptHashes,
        requiredScriptHashes,
        'Ordinary snapshot source/config drift'
      )
      const originalCapture = readFileSync(
        join(snapshot, 'config/scripts/capture-windows-native-environment.cmd')
      )
      if (variant === 'fallback') {
        writeFileSync(
          join(snapshot, 'config/scripts/capture-windows-native-environment.cmd'),
          '@echo off\r\nexit /b 7\r\n'
        )
      }
      const sample = {
        label,
        variant,
        sourceHashesBeforeInjection: snapshotScriptHashes,
        originalCaptureSha256: hash(originalCapture),
        addonDirectories: directories,
        measurements: []
      }
      report.samples.push(sample)
      for (const warm of [false, true]) {
        const stage = `${label}-${warm ? 'warm' : 'cold'}`
        const traceFile = join(output, `${stage}.trace.json`)
        const script = join(snapshot, 'config/scripts', variant === 'control' ? control : candidate)
        const args = [
          '--import',
          pathToFileURL(join(snapshot, 'config/scripts/windows-native-benchmark-observer.mjs'))
            .href,
          script,
          ...(variant === 'control' ? ['--runtime=node'] : [])
        ]
        const result = await command(stage, process.execPath, args, snapshot, {
          ...environment,
          ORCA_NATIVE_BENCHMARK_TRACE: traceFile
        })
        assertNoHeaderDownloads(result)
        const receipt = JSON.parse(readFileSync(traceFile, 'utf8'))
        validateObservedPreparation(receipt, variant, warm)
        if (variant === 'fallback' && !warm) {
          assert(result.stderr.includes('retaining node-gyp discovery'), 'Fallback warning missing')
        }
        const final = await command(
          `${stage}-final-probe`,
          process.execPath,
          [join(snapshot, 'config/scripts', control), '--check-only'],
          snapshot
        )
        assert.equal(final.code, 0)
        const calls = receipt.calls
        const milliseconds = (phase) =>
          calls
            .filter((call) => call.phase === phase)
            .reduce((total, call) => total + call.durationMs, 0)
        sample.measurements.push({
          warm,
          totalPreparationMs: result.durationMs,
          helperDiscoveryMs: milliseconds('discovery'),
          helperCaptureMs: milliseconds('capture'),
          helperPreprobeMs: milliseconds('probe'),
          unchangedPreparationChildMs: variant === 'control' ? null : milliseconds('preparation'),
          helperOutsidePreparationChildMs:
            variant === 'control' ? null : result.durationMs - milliseconds('preparation'),
          traceFile: relative(output, traceFile),
          traceSha256: hash(readFileSync(traceFile)),
          binaries: binaryReceipt(snapshot)
        })
        assert.deepEqual(
          treeDigest(headers),
          headersBefore,
          'Timed preparation changed prefilled headers/libraries'
        )
        assert.equal(
          environmentReceipt(process.env).hash,
          parentBefore.hash,
          'Parent environment changed'
        )
        assert.equal(
          existsSync(process.env.GITHUB_ENV ?? '')
            ? hash(readFileSync(process.env.GITHUB_ENV))
            : null,
          githubEnvironmentBefore,
          'Compiler setup wrote GITHUB_ENV'
        )
        writeReport()
      }
      sample.isolatedCopyWindowMs = report.phases
        .filter((phase) => phase.label.startsWith(`${label}-`))
        .reduce((total, phase) => total + phase.durationMs, 0)
      sample.injectedCaptureSha256 =
        variant === 'fallback'
          ? hash(
              readFileSync(join(snapshot, 'config/scripts/capture-windows-native-environment.cmd'))
            )
          : null
    }
    report.comparison = Object.fromEntries(
      [false, true].map((warm) => {
        const timings = (variant) =>
          report.samples
            .filter((sample) => sample.variant === variant)
            .map(
              (sample) =>
                sample.measurements.find((measurement) => measurement.warm === warm)
                  .totalPreparationMs
            )
        const baseline = timings('control')
        const proposed = timings('candidate')
        return [
          warm ? 'sameBuildWarm' : 'cold',
          {
            control: summarizeBenchmarkSamples(baseline),
            candidate: summarizeBenchmarkSamples(proposed),
            pairDeltaMs: baseline.map((value, index) => proposed[index] - value),
            role: 'Two counterbalanced pairs are descriptive; no significance or ordinary CI hit-rate estimate.'
          }
        ]
      })
    )
    report.parentEnvironment = {
      before: parentBefore,
      after: environmentReceipt(process.env),
      githubEnvironmentBefore,
      githubEnvironmentAfter: githubEnvironmentBefore
    }
    report.qualification = 'passed'
  } catch (error) {
    report.failure = error.message
    report.qualification = 'failed'
    throw error
  } finally {
    rmSync(temporary, { recursive: true, force: true })
    report.finishedAt = new Date().toISOString()
    report.explicitWindowMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt)
    report.explicitJobWindowMs =
      Date.parse(report.finishedAt) - Date.parse(report.firstRecordedJobStep.startedAt)
    writeReport()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await benchmarkWindowsNativePreparation()
}
