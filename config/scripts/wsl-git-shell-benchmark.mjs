import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'

import { createJiti } from 'jiti'
import {
  BENCHMARK_SAMPLE_AGGREGATION,
  summarizeBenchmarkSamples
} from './benchmark-sample-summary.mjs'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const DEFAULT_SAMPLES = 20
const DEFAULT_WARMUPS = 3

function parseArgs(argv) {
  const options = {
    distro: null,
    nativeRepo: null,
    mountedRepo: null,
    samples: DEFAULT_SAMPLES,
    warmups: DEFAULT_WARMUPS,
    loginDelayMs: 0
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[++index]
    if (!value) {
      throw new Error(`${arg} requires a value`)
    }
    if (arg === '--distro') {
      options.distro = value
    } else if (arg === '--native-repo') {
      options.nativeRepo = value
    } else if (arg === '--mounted-repo') {
      options.mountedRepo = value
    } else if (arg === '--samples') {
      options.samples = Number(value)
    } else if (arg === '--warmups') {
      options.warmups = Number(value)
    } else if (arg === '--login-delay-ms') {
      options.loginDelayMs = Number(value)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  for (const [name, value, minimum] of [
    ['samples', options.samples, 5],
    ['warmups', options.warmups, 0],
    ['login-delay-ms', options.loginDelayMs, 0]
  ]) {
    if (!Number.isInteger(value) || value < minimum || value > 1_000) {
      throw new Error(`--${name} must be an integer between ${minimum} and 1000`)
    }
  }
  if (options.samples % 2 !== 0) {
    throw new Error('--samples must be even so ABBA blocks are counterbalanced')
  }
  if (!options.nativeRepo || !options.mountedRepo) {
    throw new Error('--native-repo and --mounted-repo are required')
  }
  return options
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (status) => {
      const result = {
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      }
      if (status === 0 || options.allowFailure) {
        resolve(result)
      } else {
        reject(new Error(`${command} exited ${status}: ${result.stderr.toString('utf8').trim()}`))
      }
    })
  })
}

function wslArgs(distro, args) {
  return ['-d', distro, '--exec', ...args]
}

async function resolveDistro(requested) {
  if (requested) {
    return requested
  }
  const result = await run('wsl.exe', ['--list', '--quiet'], {
    env: { ...process.env, WSL_UTF8: '1' }
  })
  const distro = result.stdout
    .toString('utf8')
    .replaceAll('\0', '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean)
  if (!distro) {
    throw new Error('No WSL distro is installed')
  }
  return distro
}

function assertRepoPath(path, expectedPrefix) {
  if (!path.startsWith(expectedPrefix) || path.includes('\0') || path.includes('\n')) {
    throw new Error(`Unexpected benchmark repository path: ${path}`)
  }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This benchmark requires a Windows host with WSL')
  }
  const options = parseArgs(process.argv.slice(2))
  assertRepoPath(options.nativeRepo, '/')
  assertRepoPath(options.mountedRepo, '/mnt/')
  const distro = await resolveDistro(options.distro)
  const jiti = createJiti(import.meta.url)
  const { buildWslLoginShellCommand, quotePosixShell } = await jiti.import(
    '../../src/shared/wsl-login-shell-command.ts'
  )

  const loginProbe = buildWslLoginShellCommand(
    `printf '\\n__ORCA_PATH__%s\\n__ORCA_GIT__%s\\n__ORCA_HOME__%s\\n' "$PATH" "$(command -v git)" "$HOME"`
  )
  const probe = await run('wsl.exe', wslArgs(distro, ['/bin/sh', '-lc', loginProbe]))
  const probeText = probe.stdout.toString('utf8')
  const loginPath = /__ORCA_PATH__(.*)/.exec(probeText)?.[1]?.trim()
  const gitPath = /__ORCA_GIT__(.*)/.exec(probeText)?.[1]?.trim()
  const loginHome = /__ORCA_HOME__(.*)/.exec(probeText)?.[1]?.trim()
  if (!loginPath || !gitPath?.startsWith('/') || !loginHome?.startsWith('/')) {
    throw new Error(`Could not resolve login-shell Git environment: ${probeText.trim()}`)
  }
  const outputMarker = `__ORCA_GIT_OUTPUT_${process.pid}__\n`

  const runGit = async (mode, repo, args) => {
    const startedAt = performance.now()
    let result
    if (mode === 'login') {
      const command = [
        `cd ${quotePosixShell(repo)} &&`,
        `printf ${quotePosixShell(outputMarker)} &&`,
        `LC_ALL=C LANG=C ${quotePosixShell('git')}`,
        ...args.map(quotePosixShell)
      ].join(' ')
      const delay = options.loginDelayMs > 0 ? `sleep ${options.loginDelayMs / 1_000}; ` : ''
      const script = `${delay}${buildWslLoginShellCommand(command)}`
      result = await run('wsl.exe', wslArgs(distro, ['/bin/sh', '-lc', script]))
      const markerOffset = result.stdout.indexOf(outputMarker)
      if (markerOffset === -1) {
        throw new Error('Login shell did not emit the Git output marker')
      }
      result.stdout = result.stdout.subarray(markerOffset + Buffer.byteLength(outputMarker))
    } else {
      result = await run(
        'wsl.exe',
        wslArgs(distro, [
          '/usr/bin/env',
          `PATH=${loginPath}`,
          `HOME=${loginHome}`,
          'LC_ALL=C',
          'LANG=C',
          gitPath,
          '-C',
          repo,
          ...args
        ])
      )
    }
    return { ...result, elapsedMs: performance.now() - startedAt }
  }

  const measure = async (label, runArm) => {
    for (let index = 0; index < options.warmups; index += 1) {
      await runArm('login')
      await runArm('fast')
    }
    const samples = { login: [], fast: [] }
    const schedule = buildCounterbalancedSchedule(options.samples, 'login', 'fast')
    for (const order of schedule) {
      const results = []
      for (const mode of order) {
        const result = await runArm(mode)
        samples[mode].push(result.elapsedMs)
        results.push(result)
      }
      if (
        results[0].status !== results[1].status ||
        !results[0].stdout.equals(results[1].stdout) ||
        !results[0].stderr.equals(results[1].stderr)
      ) {
        throw new Error(
          `${label} correctness mismatch between ${order.join(' and ')} arms:\n` +
            `${order[0]}=${JSON.stringify({ stdout: results[0].stdout.toString('utf8'), stderr: results[0].stderr.toString('utf8') })}\n` +
            `${order[1]}=${JSON.stringify({ stdout: results[1].stdout.toString('utf8'), stderr: results[1].stderr.toString('utf8') })}`
        )
      }
    }
    const login = summarizeBenchmarkSamples(samples.login)
    const fast = summarizeBenchmarkSamples(samples.fast)
    return {
      login,
      fast,
      medianSpeedup: Number((login.medianMs / fast.medianMs).toFixed(2)),
      medianSavedMs: Number((login.medianMs - fast.medianMs).toFixed(1))
    }
  }

  const benchmarkRepo = async (repo) => {
    const branch = (
      await runGit('fast', repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    ).stdout
      .toString('utf8')
      .trim()
    const fixtureName = `.orca-wsl-git-shell-benchmark-${process.pid}-${randomUUID()}.txt`
    const fixturePath = posix.join(repo, fixtureName)
    const prepareStage = async () => {
      await runGit('fast', repo, ['reset', '--quiet', '--', fixtureName])
      await run(
        'wsl.exe',
        wslArgs(distro, [
          '/bin/sh',
          '-c',
          'printf "benchmark\\n" > "$1"',
          'orca-wsl-git-shell-benchmark',
          fixturePath
        ])
      )
    }
    const cleanupStage = async () => {
      await runGit('fast', repo, ['reset', '--quiet', '--', fixtureName])
      await run('wsl.exe', wslArgs(distro, ['/bin/rm', '-f', '--', fixturePath]))
    }

    const operations = {
      status: [
        '-c',
        'core.quotePath=false',
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=all'
      ],
      numstat: ['-c', 'core.quotePath=false', 'diff', '-z', '--numstat', '-M'],
      upstream: [
        'for-each-ref',
        '--format=%(refname)%00%(upstream)%00%(upstream:short)',
        '--count=1',
        `refs/heads/${branch}`
      ]
    }
    const result = {}
    for (const [name, args] of Object.entries(operations)) {
      result[name] = await measure(`${repo}:${name}`, (mode) => runGit(mode, repo, args))
    }
    const created = await run(
      'wsl.exe',
      wslArgs(distro, [
        '/bin/sh',
        '-c',
        'set -C; printf "benchmark\\n" > "$1"',
        'orca-wsl-git-shell-benchmark',
        fixturePath
      ]),
      { allowFailure: true }
    )
    if (created.status !== 0) {
      throw new Error(`Could not exclusively create benchmark fixture: ${fixturePath}`)
    }
    try {
      result.stageRefresh = await measure(`${repo}:stage-refresh`, async (mode) => {
        await prepareStage()
        const startedAt = performance.now()
        await runGit('login', repo, ['add', '--', fixtureName])
        const status = await runGit(mode, repo, operations.status)
        const numstat = await runGit(mode, repo, [
          '-c',
          'core.quotePath=false',
          'diff',
          '-z',
          '--cached',
          '--numstat',
          '-M'
        ])
        return {
          status: 0,
          stdout: Buffer.concat([status.stdout, numstat.stdout]),
          stderr: Buffer.concat([status.stderr, numstat.stderr]),
          elapsedMs: performance.now() - startedAt
        }
      })
    } finally {
      await cleanupStage()
    }
    return result
  }

  const verifyProductionRunner = async (repo) => {
    const windowsRepo = (
      await run('wsl.exe', wslArgs(distro, ['/usr/bin/wslpath', '-w', repo]))
    ).stdout
      .toString('utf8')
      .trim()
    const args = [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all'
    ]
    const [{ gitExecFileAsync }, { getWslGitReadEnvironment }, expected] = await Promise.all([
      jiti.import('../../src/main/git/runner.ts'),
      jiti.import('../../src/main/git/wsl-git-read-environment.ts'),
      runGit('fast', repo, args)
    ])
    await getWslGitReadEnvironment(distro)
    const startedAt = performance.now()
    const actual = await gitExecFileAsync(args, {
      cwd: windowsRepo,
      preferWslDirectGit: true,
      wslDistro: distro
    })
    if (
      !Buffer.from(actual.stdout).equals(expected.stdout) ||
      !Buffer.from(actual.stderr).equals(expected.stderr)
    ) {
      throw new Error(`Production runner output mismatch for ${windowsRepo}`)
    }
    return {
      windowsRepo,
      environmentPrimed: true,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      outputBytes: expected.stdout.length
    }
  }

  const result = {
    distro,
    gitPath,
    gitVersion: (await runGit('fast', options.nativeRepo, ['--version'])).stdout
      .toString('utf8')
      .trim(),
    samples: options.samples,
    warmups: options.warmups,
    sampleAggregation: BENCHMARK_SAMPLE_AGGREGATION,
    injectedLoginDelayMs: options.loginDelayMs,
    loginProbePreambleBytes: Buffer.byteLength(probeText.split('__ORCA_PATH__', 1)[0]),
    guestProcessShape: {
      login: 'sh -> interactive login shell -> git',
      fast: 'env -> git'
    },
    native: await benchmarkRepo(options.nativeRepo),
    mounted: await benchmarkRepo(options.mountedRepo),
    productionRunnerVerification: {
      native: await verifyProductionRunner(options.nativeRepo),
      mounted: await verifyProductionRunner(options.mountedRepo)
    }
  }
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
