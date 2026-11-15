import { readGitBaselineSources } from './git-baseline-sources.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const docker =
  process.env.ORCA_DOCKER ??
  (existsSync('/Applications/Docker.app/Contents/Resources/bin/docker')
    ? '/Applications/Docker.app/Contents/Resources/bin/docker'
    : 'docker')
const dockerDirectory = dirname(docker)
const dockerEnv = {
  ...process.env,
  ORCA_BACKGROUND_LAUNCH: '1',
  ...(dockerDirectory !== '.'
    ? { PATH: `${dockerDirectory}${delimiter}${process.env.PATH ?? ''}` }
    : {})
}
const dockerDir = join(repo, 'config/docker/daemon-shutdown-descendants')
const targets = [
  'src/main/daemon/terminal-host/terminal-host.ts',
  'src/main/daemon/terminal-host/terminal-session-teardown.ts',
  'src/main/daemon/terminal-host/terminal-host-session-shutdown.ts',
  'src/main/pty/process-retirement/pty-descendant-termination.ts',
  'src/main/pty/process-retirement/pty-descendant-exit-verification.ts'
]

function baselineSourceRelocations(ref) {
  return new Map([
    [`${ref}:src/main/daemon/daemon-errors.ts`, 'src/main/daemon/protocol/daemon-errors.ts'],
    [
      `${ref}:src/main/daemon/session-input-path.ts`,
      'src/main/daemon/sessions/session-input-path.ts'
    ],
    [`${ref}:src/main/daemon/session.ts`, 'src/main/daemon/sessions/session.ts'],
    [
      `${ref}:src/main/daemon/terminal-creation-work.ts`,
      'src/main/daemon/terminal-host/terminal-creation-work.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-descendant-shutdown.ts`,
      'src/main/daemon/sessions/terminal-descendant-shutdown.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-agent-session-claim.ts`,
      'src/main/daemon/terminal-host/terminal-host-agent-session-claim.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-agent-session-generations.ts`,
      'src/main/daemon/terminal-host/terminal-host-agent-session-generations.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-create-contract.ts`,
      'src/main/daemon/terminal-host/terminal-host-create-contract.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-disposal.ts`,
      'src/main/daemon/terminal-host/terminal-host-disposal.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-fenced-termination.ts`,
      'src/main/daemon/terminal-host/terminal-host-fenced-termination.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-options.ts`,
      'src/main/daemon/terminal-host/terminal-host-options.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-process-inspection.ts`,
      'src/main/daemon/terminal-host/terminal-host-process-inspection.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-returned-process.ts`,
      'src/main/daemon/terminal-host/terminal-host-returned-process.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-session-access.ts`,
      'src/main/daemon/terminal-host/terminal-host-session-access.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-session-create.ts`,
      'src/main/daemon/terminal-host/terminal-host-session-create.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-session-cwd.ts`,
      'src/main/daemon/terminal-host/terminal-host-session-cwd.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-session-exit.ts`,
      'src/main/daemon/terminal-host/terminal-host-session-exit.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-session-inspection-operations.ts`,
      'src/main/daemon/terminal-host/terminal-host-session-inspection-operations.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-session-listing.ts`,
      'src/main/daemon/terminal-host/terminal-host-session-listing.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-session-shutdown.ts`,
      'src/main/daemon/terminal-host/terminal-host-session-shutdown.ts'
    ],
    [
      `${ref}:src/main/daemon/terminal-host-tombstones.ts`,
      'src/main/daemon/terminal-host/terminal-host-tombstones.ts'
    ],
    [`${ref}:src/main/daemon/terminal-host.ts`, 'src/main/daemon/terminal-host/terminal-host.ts'],
    [
      `${ref}:src/main/daemon/terminal-session-teardown.ts`,
      'src/main/daemon/terminal-host/terminal-session-teardown.ts'
    ],
    [`${ref}:src/main/daemon/types.ts`, 'src/main/daemon/protocol/daemon-rpc-contract.ts'],
    [
      `${ref}:src/main/pty-descendant-termination.ts`,
      'src/main/pty/process-retirement/pty-descendant-termination.ts'
    ],
    [
      `${ref}:src/main/pty-shell-job-preservation.ts`,
      'src/main/pty/process-retirement/pty-shell-job-preservation.ts'
    ],
    [
      `${ref}:src/main/windows-process-tree-kill.ts`,
      'src/main/pty/process-retirement/windows-process-tree-kill.ts'
    ],
    [
      `${ref}:src/main/windows-pty-root-identity.ts`,
      'src/main/pty/process-retirement/windows-pty-root-identity.ts'
    ],
    [
      `${ref}:src/main/pty-process-table-parser.ts`,
      'src/main/pty/process-retirement/pty-process-table-parser.ts'
    ],
    [
      `${ref}:src/main/pty-descendant-fresh-table.ts`,
      'src/main/pty/process-retirement/pty-descendant-fresh-table.ts'
    ],
    [
      `${ref}:src/main/pty-descendant-exit-verification.ts`,
      'src/main/pty/process-retirement/pty-descendant-exit-verification.ts'
    ]
  ])
}

const args = process.argv.slice(2)
const baselineIndex = args.indexOf('--baseline')
if (
  args.length !== 0 &&
  (args.length !== 2 ||
    args[0] !== '--baseline' ||
    baselineIndex !== args.lastIndexOf('--baseline'))
) {
  throw new Error('Usage: run-daemon-shutdown-descendants-docker.mjs [--baseline <git-ref>]')
}
const baselineRef = baselineIndex === -1 ? null : args[baselineIndex + 1]
if (baselineIndex !== -1 && (!baselineRef || baselineRef.startsWith('-'))) {
  throw new Error('Usage: run-daemon-shutdown-descendants-docker.mjs [--baseline <git-ref>]')
}

const temp = mkdtempSync(join(tmpdir(), 'orca-daemon-shutdown-descendants-'))
const image = `orca-daemon-shutdown-descendants:${process.pid}-${Date.now()}`
const platform =
  process.env.ORCA_DOCKER_PLATFORM ?? (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64')

function baselinePlugin(ref) {
  const relocatedBaselineSources = baselineSourceRelocations(ref)
  const historicalSources = new Map(
    [...relocatedBaselineSources].map(([before, after]) => [after, before])
  )
  const sourceByPath = readGitBaselineSources(
    repo,
    ref,
    new Map(targets.map((file) => [file, historicalSources.get(file)]))
  )
  const relocatedImports = new Map(
    [...relocatedBaselineSources].map(([before, after]) => [
      resolve(repo, before.slice(ref.length + 1)),
      resolve(repo, after)
    ])
  )
  return {
    name: 'git-ref-baseline',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\./ }, (args) => {
        const original = resolve(args.resolveDir, args.path)
        const destination = relocatedImports.get(original) ?? relocatedImports.get(`${original}.ts`)
        return destination ? { path: destination } : undefined
      })
      buildApi.onLoad({ filter: /\.ts$/ }, (args) => {
        const source = sourceByPath.get(args.path)
        return source === undefined ? undefined : { ...source, loader: 'ts' }
      })
    }
  }
}

async function bundle(outfile, plugin) {
  await build({
    entryPoints: [join(dockerDir, 'bundle-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['node-pty'],
    plugins: plugin ? [plugin] : [],
    outfile,
    sourcemap: false,
    logLevel: 'warning'
  })
}

function runDocker(args, allowFailure = false) {
  const result = spawnSync(docker, args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: dockerEnv
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && !allowFailure) {
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`docker ${args[0]} failed with ${result.status}`)
  }
  return result
}

try {
  const candidate = join(temp, 'candidate.cjs')
  await bundle(candidate)
  const bundles = [['candidate', candidate]]
  if (baselineRef) {
    const baseline = join(temp, 'baseline.cjs')
    await bundle(baseline, baselinePlugin(baselineRef))
    bundles.unshift(['baseline', baseline])
  }

  runDocker([
    'build',
    '--platform',
    platform,
    ...(process.env.ORCA_DAEMON_SHUTDOWN_FIXTURE_CACHE_IMAGE
      ? ['--cache-from', process.env.ORCA_DAEMON_SHUTDOWN_FIXTURE_CACHE_IMAGE]
      : []),
    '-t',
    image,
    dockerDir
  ])
  for (const [mode, bundlePath] of bundles) {
    const result = runDocker(
      [
        'run',
        '--rm',
        '--platform',
        platform,
        '-e',
        'ORCA_BACKGROUND_LAUNCH=1',
        '-v',
        `${bundlePath}:/fixtures/${mode}.cjs:ro`,
        image,
        `/fixtures/${mode}.cjs`,
        mode
      ],
      true
    )
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (result.status !== 0) {
      throw new Error(`${mode} daemon-shutdown oracle failed with ${result.status}`)
    }
  }
  console.log(
    baselineRef
      ? 'Linux daemon shutdown descendant oracle passed: baseline leaks, candidate reaps, canary survives.'
      : 'Linux daemon shutdown descendant oracle passed (candidate only): descendant reaped, canary survives.'
  )
} finally {
  runDocker(['image', 'rm', image], true)
  rmSync(temp, { recursive: true, force: true })
}
