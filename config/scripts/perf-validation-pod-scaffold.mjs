import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ARTIFACT_ROOT = '.perf-validation'

function playwrightCommand({ artifactDir, prefix, repeatEach, specs, variant }) {
  return joinCommand([
    'pnpm run ensure:electron-runtime && pnpm exec playwright test',
    specs,
    '--config tests/playwright.config.ts --project electron-headless --workers=1',
    `--repeat-each=${repeatEach}`,
    '--reporter=json',
    `--output ${shellArg(joinArtifact(artifactDir, `playwright-${variant}`))}`,
    `> ${shellArg(joinArtifact(artifactDir, `${prefix}-${variant}-playwright.json`))}`
  ])
}

const PODS = {
  'ssh-relay-batching': {
    requiresDocker: true,
    artifact: (variant) => `ssh-relay-${variant}.jsonl`,
    command: (variant, { artifactDir }) =>
      joinCommand([
        envCommand(
          'ORCA_E2E_SSH_DOCKER_PERF_JSON',
          joinArtifact(artifactDir, `ssh-relay-${variant}.jsonl`)
        ),
        'pnpm run test:e2e:ssh-docker-perf -- --repeat-each=5 --reporter=json',
        `--output ${shellArg(joinArtifact(artifactDir, `playwright-${variant}`))}`,
        `> ${shellArg(joinArtifact(artifactDir, `ssh-relay-${variant}-playwright.json`))}`
      ])
  },
  'git-status-coalescing': {
    requiresDocker: false,
    artifact: (variant) => `git-status-${variant}.json`,
    command: (variant, { artifactDir }) =>
      joinCommand([
        envCommand(
          'ORCA_GIT_STATUS_COALESCING_BENCH_JSON',
          joinArtifact(artifactDir, `git-status-${variant}.json`)
        ),
        'pnpm exec vitest run --config config/vitest.config.ts src/main/git/status.test.ts',
        '-t "benchmarks concurrent status burst subprocess pressure"'
      ])
  },
  'terminal-scheduler-adaptive': {
    requiresDocker: false,
    artifact: (variant) => `terminal-scheduler-${variant}-playwright.json`,
    command: (variant, { artifactDir }) =>
      playwrightCommand({
        artifactDir,
        prefix: 'terminal-scheduler',
        repeatEach: 5,
        specs:
          'tests/e2e/terminal-output-scheduler.spec.ts tests/e2e/terminal-typing-latency.spec.ts',
        variant
      })
  },
  'startup-hydration-overlap': {
    requiresDocker: false,
    artifact: (variant) => `startup-hydration-${variant}-playwright.json`,
    command: (variant, { artifactDir }) =>
      playwrightCommand({
        artifactDir,
        prefix: 'startup-hydration',
        repeatEach: 10,
        specs: 'tests/e2e/startup-hydration-perf.spec.ts',
        variant
      })
  }
}

function joinArtifact(...parts) {
  return path.join(...parts).replaceAll(path.sep, '/')
}

function joinCommand(parts) {
  return parts.join(' ')
}

function shellArg(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

function envCommand(name, value) {
  return `${name}=${shellArg(value)}`
}

function defaultRunId(now = new Date()) {
  return now
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z')
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function parsePerfValidationPodArgs(argv, env = process.env) {
  const options = {
    artifactRoot: env.ORCA_PERF_VALIDATION_ARTIFACT_ROOT || DEFAULT_ARTIFACT_ROOT,
    check: false,
    json: false,
    pod: env.ORCA_PERF_VALIDATION_POD || null,
    runId: env.ORCA_PERF_VALIDATION_RUN_ID || defaultRunId()
  }

  if (argv[0] === '--') {
    argv = argv.slice(1)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--pod') {
      options.pod = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--run-id') {
      options.runId = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--artifact-root') {
      options.artifactRoot = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--check') {
      options.check = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--help') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!options.help && !options.pod) {
    throw new Error('--pod is required')
  }
  if (options.pod && !PODS[options.pod]) {
    throw new Error(`Unsupported pod: ${options.pod}`)
  }
  return options
}

export function buildPerfValidationPodScaffold({
  artifactRoot = DEFAULT_ARTIFACT_ROOT,
  cwd = process.cwd(),
  pod,
  runId = defaultRunId()
}) {
  const definition = PODS[pod]
  if (!definition) {
    throw new Error(`Unsupported pod: ${pod}`)
  }
  const artifactDir = joinArtifact(artifactRoot, runId, pod)
  const commandContext = { artifactDir, cwd, pod, runId }
  const preflightChecks = [
    { command: ['git', 'status', '--short'], name: 'git-clean' },
    { command: ['pnpm', '--version'], name: 'pnpm' }
  ]
  if (definition.requiresDocker) {
    preflightChecks.push({ command: ['docker', 'info'], name: 'docker-daemon' })
  }

  return {
    artifactDir,
    baselineArtifactPath: joinArtifact(artifactDir, definition.artifact('baseline')),
    baselineCommand: definition.command('baseline', commandContext),
    candidateArtifactPath: joinArtifact(artifactDir, definition.artifact('candidate')),
    candidateCommand: definition.command('candidate', commandContext),
    pod,
    preflightChecks,
    resultPacketPath: joinArtifact(artifactDir, 'result-packet.json'),
    runId,
    worktreePath: cwd
  }
}

function commandOutput(result, key) {
  const value = result[key]
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
  return text.replace(/\s+$/u, '')
}

function runCheck(check, spawnSyncImpl, cwd) {
  const [command, ...args] = check.command
  const result = spawnSyncImpl(command, args, { cwd, encoding: 'utf8' })
  const stdout = commandOutput(result, 'stdout')
  const stderr = commandOutput(result, 'stderr')
  const status = result.status ?? (result.signal ? 1 : 0)

  if (check.name === 'git-clean' && stdout.length > 0) {
    return {
      details: stdout,
      name: check.name,
      ok: false,
      reason: 'worktree has uncommitted changes'
    }
  }

  if (status !== 0) {
    return {
      details: stdout,
      name: check.name,
      ok: false,
      reason: stderr || stdout || `${command} exited with status ${status}`
    }
  }

  return { name: check.name, ok: true }
}

export function runPerfValidationPodPreflight({
  mkdirSyncImpl = mkdirSync,
  scaffold,
  spawnSyncImpl = spawnSync
}) {
  mkdirSyncImpl(scaffold.artifactDir, { recursive: true })
  const checks = scaffold.preflightChecks.map((check) =>
    runCheck(check, spawnSyncImpl, scaffold.worktreePath)
  )
  return {
    checks,
    ok: checks.every((check) => check.ok),
    resultPacketPath: scaffold.resultPacketPath
  }
}

export function makeResultPacketTemplate(scaffold, preflight = null) {
  return {
    artifactDir: scaffold.artifactDir,
    baseline: {
      artifactPath: scaffold.baselineArtifactPath,
      command: scaffold.baselineCommand,
      median: null,
      tail: null
    },
    branch: null,
    candidate: {
      artifactPath: scaffold.candidateArtifactPath,
      command: scaffold.candidateCommand,
      median: null,
      tail: null
    },
    decision: null,
    filesChanged: [],
    pod: scaffold.pod,
    preflight,
    resultPacketPath: scaffold.resultPacketPath,
    runId: scaffold.runId,
    thresholdPassed: null,
    worktreePath: scaffold.worktreePath
  }
}

function printText(scaffold, preflight) {
  console.log(`Pod: ${scaffold.pod}`)
  console.log(`Run ID: ${scaffold.runId}`)
  console.log(`Artifact dir: ${scaffold.artifactDir}`)
  console.log(`Result packet: ${scaffold.resultPacketPath}`)
  if (preflight) {
    for (const check of preflight.checks) {
      console.log(
        `${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.reason ? `: ${check.reason}` : ''}`
      )
    }
  }
  console.log('\nBaseline command:')
  console.log(scaffold.baselineCommand)
  console.log('\nCandidate command:')
  console.log(scaffold.candidateCommand)
}

function usage() {
  return `Usage: node config/scripts/perf-validation-pod-scaffold.mjs --pod <name> [options]\n\nPods:\n${Object.keys(
    PODS
  )
    .map((pod) => `  - ${pod}`)
    .join(
      '\n'
    )}\n\nOptions:\n  --run-id <id>         Shared validation run id\n  --artifact-root <dir> Durable artifact root (default ${DEFAULT_ARTIFACT_ROOT})\n  --check              Run local preflight checks and create artifact dir\n  --json               Print JSON scaffold and packet template\n`
}

export function runPerfValidationPodScaffoldCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = console.log
} = {}) {
  try {
    const options = parsePerfValidationPodArgs(argv, env)
    if (options.help) {
      stdout(usage())
      return 0
    }
    const scaffold = buildPerfValidationPodScaffold({ ...options, cwd })
    const preflight = options.check ? runPerfValidationPodPreflight({ scaffold }) : null
    const packet = makeResultPacketTemplate(scaffold, preflight)
    if (options.check) {
      writeFileSync(scaffold.resultPacketPath, `${JSON.stringify(packet, null, 2)}\n`)
    }
    if (options.json) {
      stdout(JSON.stringify({ packet, scaffold }, null, 2))
    } else {
      printText(scaffold, preflight)
    }
    return preflight?.ok === false ? 1 : 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runPerfValidationPodScaffoldCli())
}
