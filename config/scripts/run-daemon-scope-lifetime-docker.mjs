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
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--baseline' || !args[1] || args[1].startsWith('-')) {
  throw new Error('Usage: run-daemon-scope-lifetime-docker.mjs --baseline <git-ref>')
}
const baselineRef = args[1]
const dockerDir = join(repo, 'config/docker/daemon-scope-lifetime')
const temp = mkdtempSync(join(tmpdir(), 'orca-daemon-scope-lifetime-'))
const suffix = `${process.pid}-${Date.now()}`
const image = `orca-daemon-scope-lifetime:${suffix}`
const container = `orca-daemon-scope-lifetime-${suffix}`
const platform =
  process.env.ORCA_DOCKER_PLATFORM ?? (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64')

function runDocker(command, allowFailure = false) {
  const result = spawnSync(docker, command, {
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
    throw new Error(`docker ${command[0]} failed with ${result.status}`)
  }
  return result
}

async function bundle(mode) {
  const productionScopePath = join(repo, 'src/main/daemon/daemon-cgroup-scope.ts')
  const baselineSource =
    mode === 'baseline'
      ? execFileSync('git', ['show', `${baselineRef}:src/main/daemon/daemon-cgroup-scope.ts`], {
          cwd: repo,
          encoding: 'utf8'
        })
      : null
  await build({
    ...(mode === 'candidate'
      ? { entryPoints: [join(dockerDir, 'bundle-entry.ts')] }
      : {
          stdin: {
            contents:
              "export { buildDurableDaemonScopeCommand } from './src/main/daemon/daemon-cgroup-scope'",
            resolveDir: repo,
            loader: 'ts'
          }
        }),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: join(temp, `${mode}.cjs`),
    logLevel: 'warning',
    plugins:
      baselineSource === null
        ? []
        : [
            {
              name: 'baseline-daemon-scope',
              setup(buildApi) {
                buildApi.onLoad({ filter: /daemon-cgroup-scope\.ts$/ }, ({ path }) =>
                  path === productionScopePath
                    ? { contents: baselineSource, loader: 'ts', resolveDir: dirname(path) }
                    : undefined
                )
              }
            }
          ]
  })
}

try {
  await bundle('baseline')
  await bundle('candidate')
  runDocker(['build', '--platform', platform, '-t', image, dockerDir])
  runDocker([
    'run',
    '--detach',
    '--name',
    container,
    '--platform',
    platform,
    '--privileged',
    '--cgroupns=host',
    '--security-opt',
    'label=disable',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/run/lock',
    '-v',
    '/sys/fs/cgroup:/sys/fs/cgroup:rw',
    '-e',
    'ORCA_BACKGROUND_LAUNCH=1',
    image
  ])
  runDocker(['cp', `${temp}/.`, `${container}:/opt/daemon-scope-lifetime/`])
  runDocker([
    'exec',
    container,
    '/bin/sh',
    '-c',
    [
      'systemctl start systemd-logind.service',
      'loginctl enable-linger orca-repro',
      'systemctl start user@1100.service',
      'test -S /run/user/1100/bus'
    ].join(' && ')
  ])
  for (const mode of ['baseline', 'candidate']) {
    const result = runDocker(
      [
        'exec',
        container,
        'timeout',
        '--kill-after=5s',
        '90s',
        'runuser',
        '-u',
        'orca-repro',
        '--',
        'env',
        'XDG_RUNTIME_DIR=/run/user/1100',
        'ORCA_BACKGROUND_LAUNCH=1',
        'node',
        '/opt/daemon-scope-lifetime/run-cases.cjs',
        `/opt/daemon-scope-lifetime/${mode}.cjs`,
        mode
      ],
      true
    )
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (result.status !== 0) {
      throw new Error(`${mode} scope lifetime oracle failed with ${result.status}`)
    }
  }
  console.log(
    'Linux systemd scope lifetime oracle passed: baseline accumulates orphans; candidate reaps them; live and unrelated work survives.'
  )
} finally {
  runDocker(['rm', '--force', container], true)
  runDocker(['image', 'rm', image], true)
  rmSync(temp, { recursive: true, force: true })
}
