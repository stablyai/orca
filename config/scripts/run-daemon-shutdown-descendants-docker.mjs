import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { materializeRuntime } from './build-orcad-bun.mjs'
import { runProcessSync } from './script-child-process.mjs'

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
  const result = runProcessSync({
    program: 'git',
    args: ['show', `${ref}:${relativePath}`],
    cwd: repo,
    maxOutputBytes: 1024 * 1024
  })
  if (result.code !== 0 || result.outputTruncated) {
    throw new Error(`Could not read baseline source ${ref}:${relativePath}: ${result.stderr}`)
  }
  return result.stdout
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
    target: 'es2024',
    external: ['bun:ffi'],
    plugins: plugin ? [plugin] : [],
    outfile,
    sourcemap: false,
    logLevel: 'warning'
  })
}

function runDocker(args, allowFailure = false, timeoutMs = 60_000) {
  const result = runProcessSync({
    program: docker,
    args,
    cwd: repo,
    maxOutputBytes: 16 * 1024 * 1024,
    timeoutMs,
    env: dockerEnv
  })
  if ((result.code !== 0 || result.timedOut) && !allowFailure) {
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`docker ${args[0]} failed: exit=${result.code} timeout=${result.timedOut}`)
  }
  return result
}

if (!['linux/amd64', 'linux/arm64'].includes(platform)) {
  rmSync(temp, { recursive: true, force: true })
  throw new Error(`Unsupported daemon oracle platform: ${platform}`)
}

let imageBuilt = false
try {
  for (const name of ['Dockerfile', 'run-case.sh', 'fixture.cjs']) {
    copyFileSync(join(dockerDir, name), join(temp, name))
  }
  const target = platform === 'linux/arm64' ? 'linux-arm64-glibc' : 'linux-x64-glibc'
  await materializeRuntime(target, join(temp, 'bun-runtime'))
  const candidate = join(temp, 'candidate.cjs')
  await bundle(candidate)
  const bundles = [['candidate', candidate]]
  if (baselineRef) {
    const baseline = join(temp, 'baseline.cjs')
    await bundle(baseline, baselinePlugin(baselineRef))
    bundles.unshift(['baseline', baseline])
  }

  runDocker(['build', '--platform', platform, '-t', image, temp], false, 300_000)
  imageBuilt = true
  for (const [mode, bundlePath] of bundles) {
    const containerName = `${image.replace(':', '-')}-${mode}`
    let result
    let cleanup
    try {
      result = runDocker(
        [
          'run',
          '--rm',
          '--name',
          containerName,
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
    } finally {
      // Killing the Docker client does not stop its container.
      cleanup = runDocker(['rm', '--force', containerName], true, 10_000)
    }
    if (cleanup.timedOut || (cleanup.code !== 0 && !cleanup.stderr.includes('No such container'))) {
      throw new Error(
        `Could not remove qualification container ${containerName}: ${cleanup.stderr}`
      )
    }
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (result.code !== 0 || result.timedOut) {
      throw new Error(
        `${mode} daemon-shutdown oracle failed: exit=${result.code} timeout=${result.timedOut}`
      )
    }
  }
  console.log(
    baselineRef
      ? 'Linux daemon shutdown descendant oracle passed: baseline leaks, candidate reaps, canary survives.'
      : 'Linux daemon shutdown descendant oracle passed (candidate only): descendant reaped, canary survives.'
  )
} finally {
  if (imageBuilt) {
    runDocker(['image', 'rm', image], true)
  }
  rmSync(temp, { recursive: true, force: true })
}
