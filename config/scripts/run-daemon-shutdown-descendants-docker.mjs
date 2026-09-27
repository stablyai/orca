import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
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
  'src/main/daemon/terminal-host.ts',
  'src/main/daemon/terminal-session-teardown.ts',
  'src/main/daemon/terminal-host-session-shutdown.ts',
  'src/main/pty-descendant-termination.ts',
  'src/main/pty-descendant-exit-verification.ts'
]

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

function gitSource(relativePath, ref) {
  return execFileSync('git', ['show', `${ref}:${relativePath}`], {
    cwd: repo,
    encoding: 'utf8'
  })
}

function baselinePlugin(ref) {
  const sourceByPath = new Map(
    targets.map((relativePath) => [resolve(repo, relativePath), gitSource(relativePath, ref)])
  )
  return {
    name: 'git-ref-baseline',
    setup(buildApi) {
      buildApi.onLoad({ filter: /\.ts$/ }, (args) => {
        const contents = sourceByPath.get(args.path)
        return contents === undefined
          ? undefined
          : { contents, loader: 'ts', resolveDir: dirname(args.path) }
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

  runDocker(['build', '--platform', platform, '-t', image, dockerDir])
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
