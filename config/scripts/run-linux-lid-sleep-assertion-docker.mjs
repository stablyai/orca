import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const fixture = join(repo, 'config/docker/linux-lid-sleep-assertion')
const sourcePath = join(repo, 'src/main/linux-lid-sleep-assertion.ts')
const args = process.argv.slice(2)
const options = new Map()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]
  const value = args[index + 1]
  if (
    !['--baseline', '--container'].includes(key) ||
    !value ||
    value.startsWith('-') ||
    options.has(key)
  ) {
    throw new Error(
      'Usage: run-linux-lid-sleep-assertion-docker.mjs [--baseline <git-ref>] [--container <name>]'
    )
  }
  options.set(key, value)
}
const baseline = options.get('--baseline')
const suffix = `${process.pid}-${Date.now()}`
const container = options.get('--container') ?? `orca-inhibitor-oracle-${suffix}`
const image = `orca-inhibitor-oracle:${suffix}`
const docker =
  process.env.ORCA_DOCKER ??
  (existsSync('/Applications/Docker.app/Contents/Resources/bin/docker')
    ? '/Applications/Docker.app/Contents/Resources/bin/docker'
    : 'docker')
const dockerDir = dirname(docker)
const env = {
  ...process.env,
  ORCA_BACKGROUND_LAUNCH: '1',
  PATH: `${dockerDir}${delimiter}${process.env.PATH ?? ''}`
}
const platform =
  process.env.ORCA_DOCKER_PLATFORM ?? (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64')
const temp = mkdtempSync(join(tmpdir(), 'orca-inhibitor-oracle-'))
const remote = `/tmp/orca-inhibitor-oracle-${suffix}`

function runDocker(command, allowFailure = false) {
  const result = spawnSync(docker, command, {
    cwd: repo,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${command[0]} failed: ${result.stdout}\n${result.stderr}`)
  }
  return result
}

async function bundle(mode, ref) {
  const oldSource = ref
    ? execFileSync('git', ['show', `${ref}:src/main/linux-lid-sleep-assertion.ts`], {
        cwd: repo,
        encoding: 'utf8'
      })
    : null
  await build({
    entryPoints: [sourcePath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: join(temp, `${mode}.cjs`),
    logLevel: 'warning',
    plugins:
      oldSource === null
        ? []
        : [
            {
              name: 'baseline-source',
              setup(api) {
                api.onLoad({ filter: /linux-lid-sleep-assertion\.ts$/ }, () => ({
                  contents: oldSource,
                  loader: 'ts',
                  resolveDir: dirname(sourcePath)
                }))
              }
            }
          ]
  })
}

try {
  await bundle('candidate')
  if (baseline) {
    await bundle('baseline', baseline)
  }
  for (const file of ['owner.cjs', 'oracle.cjs']) {
    copyFileSync(join(fixture, file), join(temp, file))
  }
  if (!options.has('--container')) {
    runDocker(['build', '--platform', platform, '-t', image, fixture])
    runDocker([
      'run',
      '-d',
      '--name',
      container,
      '--platform',
      platform,
      '--privileged',
      '--cgroupns=host',
      '--tmpfs',
      '/run',
      '--tmpfs',
      '/run/lock',
      '-v',
      '/sys/fs/cgroup:/sys/fs/cgroup:rw',
      image
    ])
  }
  const deadline = Date.now() + 20000
  while (
    runDocker(['exec', container, 'systemctl', 'is-active', 'systemd-logind'], true).status !== 0
  ) {
    if (Date.now() >= deadline) {
      throw new Error('systemd-logind did not start')
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  runDocker(['exec', container, 'mkdir', remote])
  runDocker(['cp', `${temp}/.`, `${container}:${remote}`])
  for (const mode of baseline ? ['baseline', 'candidate'] : ['candidate']) {
    const result = runDocker([
      'exec',
      '-e',
      'ORCA_BACKGROUND_LAUNCH=1',
      container,
      'node',
      `${remote}/oracle.cjs`,
      mode,
      `${remote}/${mode}.cjs`
    ])
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
  }
} finally {
  runDocker(['exec', container, 'rm', '-rf', remote], true)
  if (!options.has('--container')) {
    runDocker(['rm', '-f', container], true)
    runDocker(['image', 'rm', image], true)
  }
  rmSync(temp, { recursive: true, force: true })
}
