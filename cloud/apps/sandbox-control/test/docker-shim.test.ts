// PARITY-DOCKER: the VM's `docker` (image/vm/docker) installs Ubuntu's pinned Docker on first use,
// starts dockerd on the first command that needs it, says once what differs from a laptop, then is
// plain docker; the control plane's switch (SANDBOX_DOCKER=off -> ~/.orca-sandbox/docker.off) makes
// it refuse instead.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0
const SHIM = fileURLToPath(new URL('../image/vm/docker', import.meta.url).href)

let dir = ''
let home = ''

// A stand-in docker CLI: `info` answers once the fake daemon is up; anything else echoes its args.
const FAKE_DOCKER = `#!/usr/bin/env bash
if [ "$1" = info ]; then [ -f "$FAKE_DIR/up" ]; exit $?; fi
echo "real docker $*"
`
// A stand-in apt-get: logs each call; `install` puts the fake docker CLI in place. FAKE_APT_FAIL fails
// every call (archive unreachable); FAKE_APT_FAIL_INSTALL only the install.
const FAKE_APT = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/apt"
[ -n "\${FAKE_APT_FAIL:-}" ] && { echo "E: Unable to fetch" >&2; exit 100; }
[ "$1" = install ] && [ -n "\${FAKE_APT_FAIL_INSTALL:-}" ] && { echo "E: Version not found" >&2; exit 100; }
[ "$1" = install ] && { sleep 0.2; cp "$FAKE_DIR/docker.pkg" "$FAKE_DIR/docker"; chmod 755 "$FAKE_DIR/docker"; }
exit 0
`
// A stand-in dockerd: counts its starts and comes up (or never does, with FAKE_NEVER_UP).
const FAKE_DOCKERD = `#!/usr/bin/env bash
echo x >>"$FAKE_DIR/starts"
[ -n "\${FAKE_NEVER_UP:-}" ] && exit 1
sleep 0.2
: >"$FAKE_DIR/up"
[ -n "\${FAKE_LINGER:-}" ] && sleep "$FAKE_LINGER"
exit 0
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-docker-shim-'))
  home = join(dir, 'home')
  mkdirSync(join(home, '.orca-sandbox'), { recursive: true })
  // Not installed yet: apt-get install copies docker.pkg to docker.
  writeFileSync(join(dir, 'docker.pkg'), FAKE_DOCKER, { mode: 0o755 })
  writeFileSync(join(dir, 'apt-get'), FAKE_APT, { mode: 0o755 })
  writeFileSync(join(dir, 'dockerd'), FAKE_DOCKERD, { mode: 0o755 })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function envFor(extra: Record<string, string>): Record<string, string> {
  return {
      PATH: '/usr/bin:/bin',
      HOME: home,
      FAKE_DIR: dir,
      ORCA_REAL_DOCKER: join(dir, 'docker'),
      ORCA_DOCKERD: join(dir, 'dockerd'),
      ORCA_DOCKER_SUDO: '',
      ORCA_DOCKERD_LOG: join(dir, 'dockerd.log'),
      ORCA_DOCKER_LOCK: join(dir, 'dockerd.lock'),
      ORCA_DOCKER_WAIT_TICKS: '40',
      ORCA_DOCKER_APT: join(dir, 'apt-get'),
      ORCA_DOCKER_CONFIG: join(dir, 'etc', 'daemon.json'),
      ...extra
  }
}

function docker(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync('bash', [SHIM, ...args], { encoding: 'utf8', env: envFor(extra) })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const starts = (): number =>
  existsSync(join(dir, 'starts')) ? readFileSync(join(dir, 'starts'), 'utf8').trim().split('\n').length : 0

const aptCalls = (): string[] =>
  existsSync(join(dir, 'apt')) ? readFileSync(join(dir, 'apt'), 'utf8').trim().split('\n') : []
const installed = () => writeFileSync(join(dir, 'docker'), FAKE_DOCKER, { mode: 0o755 })

// Real processes and sleeps: loaded CI hosts need headroom over vitest's 5 s default.
describe('the docker shim (PARITY-DOCKER)', { timeout: 20_000 }, () => {
  it('first use installs the pinned packages, writes the daemon config, starts dockerd once, then runs plain docker', () => {
    const first = docker(['run', '--rm', 'hello-world'])
    expect(first.status).toBe(0)
    expect(first.stdout).toBe('real docker run --rm hello-world\n')
    expect(first.stderr).toContain('Setting up Docker in this workspace (first use, about 10 seconds)')
    expect(first.stderr).toContain('Downloading and installing Docker (about 110 MB)')
    expect(first.stderr).not.toContain('E: ')
    expect(first.stderr).toContain('Running containers stop when the workspace sleeps')
    expect(first.stderr).toContain("Containers that call github.com or an agent's API need to trust this workspace's proxy certificate")
    expect(first.stderr).toContain('vercel-proxy-ca.pem')
    expect(aptCalls()).toEqual([
      'update -qq',
      'install -y -qq --no-install-recommends docker.io=29.1.3-0ubuntu4.1 docker-compose-v2=2.40.3+ds1-0ubuntu1 docker-buildx=0.30.1-0ubuntu1'
    ])
    expect(JSON.parse(readFileSync(join(dir, 'etc', 'daemon.json'), 'utf8'))).toMatchObject({
      'storage-driver': 'overlay2',
      'registry-mirrors': ['https://mirror.gcr.io']
    })
    expect(starts()).toBe(1)

    // Installed and up: no apt, no second start, no notice.
    const again = docker(['ps'])
    expect(again.stdout).toBe('real docker ps\n')
    expect(again.stderr).toBe('')
    expect(aptCalls()).toHaveLength(2)
    expect(starts()).toBe(1)
  })

  // The VM has util-linux flock; macOS dev hosts don't, so the race is only checked where it exists.
  it.skipIf(!hasFlock)('two first commands at once install once and start one daemon', async () => {
    const run = (args: string[]) =>
      new Promise<number | null>((resolve) => {
        const child = spawn('bash', [SHIM, ...args], { env: envFor({}), stdio: 'ignore' })
        child.on('exit', resolve)
      })
    expect(await Promise.all([run(['ps']), run(['images'])])).toEqual([0, 0])
    expect(aptCalls().filter((call) => call.startsWith('install'))).toHaveLength(1)
    expect(starts()).toBe(1)
  })

  it('returns as soon as docker answers: the long-running daemon holds none of the caller\'s output open', () => {
    const t0 = Date.now()
    const first = docker(['ps'], { FAKE_LINGER: '8' })
    expect(first.status).toBe(0)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('an unreachable archive says so, runs nothing, and the next docker retries', () => {
    const failed = docker(['ps'], { FAKE_APT_FAIL: '1' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain(
      "orca: Couldn't set up Docker in this workspace because the Ubuntu package archive couldn't be reached. Run docker again to retry. Details: "
    )
    expect(failed.stderr).toContain('dockerd.log')
    expect(failed.stdout).toBe('')
    expect(starts()).toBe(0)

    // "Run docker again to retry" is true: the next command installs.
    const retried = docker(['ps'])
    expect(retried.status).toBe(0)
    expect(retried.stdout).toBe('real docker ps\n')
  })

  it('a failed install (archive reachable) says so without blaming the network', () => {
    const failed = docker(['ps'], { FAKE_APT_FAIL_INSTALL: '1' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("orca: Couldn't set up Docker in this workspace. Run docker again to retry. Details: ")
    expect(failed.stderr).not.toContain('archive')
    expect(starts()).toBe(0)
  })

  it('never starts the daemon for --version, help, or a DOCKER_HOST elsewhere', () => {
    installed()
    expect(docker(['--version']).stdout).toBe('real docker --version\n')
    expect(docker(['help']).stdout).toBe('real docker help\n')
    expect(docker(['ps'], { DOCKER_HOST: 'tcp://elsewhere:2375' }).stdout).toBe('real docker ps\n')
    expect(starts()).toBe(0)
    expect(aptCalls()).toEqual([])
  })

  it('says so when dockerd never comes up, and the next docker retries the start', () => {
    installed()
    const failed = docker(['ps'], { FAKE_NEVER_UP: '1', ORCA_DOCKER_WAIT_TICKS: '5' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("orca: Docker couldn't start in this workspace. Run docker again to retry. Details: ")
    expect(failed.stderr).toContain('dockerd.log')
    expect(failed.stdout).toBe('')

    const retried = docker(['ps'])
    expect(retried.status).toBe(0)
    expect(starts()).toBe(2)
  })

  it('says containers stop on sleep at every daemon start, the proxy certificate only at the first', () => {
    installed()
    expect(docker(['ps']).stderr).toContain('proxy certificate')
    rmSync(join(dir, 'up')) // the workspace slept: the daemon is gone
    const woke = docker(['ps'])
    expect(woke.stderr).toContain('Running containers stop when the workspace sleeps')
    expect(woke.stderr).not.toContain('proxy certificate')
    expect(starts()).toBe(2)
  })

  it('leaves an existing daemon config alone', () => {
    mkdirSync(join(dir, 'etc'))
    writeFileSync(join(dir, 'etc', 'daemon.json'), '{"mine":true}')
    expect(docker(['ps']).status).toBe(0)
    expect(readFileSync(join(dir, 'etc', 'daemon.json'), 'utf8')).toBe('{"mine":true}')
  })

  it('turned off by the control plane: refuses with a plain message and installs or starts nothing', () => {
    writeFileSync(join(home, '.orca-sandbox', 'docker.off'), '')
    const refused = docker(['run', 'redis'])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toBe('orca: Docker is turned off for Orca Cloud workspaces right now.\n')
    expect(refused.stdout).toBe('')
    expect(aptCalls()).toEqual([])
    expect(starts()).toBe(0)
  })
})
