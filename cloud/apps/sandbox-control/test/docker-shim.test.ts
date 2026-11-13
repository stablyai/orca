// PARITY-DOCKER: the VM's `docker` (image/vm/docker) starts dockerd on the first command that needs
// it, says once what differs from a laptop, then is plain docker; the control plane's switch
// (SANDBOX_DOCKER=off -> ~/.orca-sandbox/docker.off) makes it refuse instead.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SHIM = fileURLToPath(new URL('../image/vm/docker', import.meta.url).href)

let dir = ''
let home = ''

// A stand-in docker CLI: `info` answers once the fake daemon is up; anything else echoes its args.
const FAKE_DOCKER = `#!/usr/bin/env bash
if [ "$1" = info ]; then [ -f "$FAKE_DIR/up" ]; exit $?; fi
echo "real docker $*"
`
// A stand-in dockerd: counts its starts and comes up (or never does, with FAKE_NEVER_UP).
const FAKE_DOCKERD = `#!/usr/bin/env bash
echo x >>"$FAKE_DIR/starts"
[ -n "\${FAKE_NEVER_UP:-}" ] && exit 1
sleep 0.2
: >"$FAKE_DIR/up"
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-docker-shim-'))
  home = join(dir, 'home')
  mkdirSync(join(home, '.orca-sandbox'), { recursive: true })
  writeFileSync(join(dir, 'docker'), FAKE_DOCKER, { mode: 0o755 })
  writeFileSync(join(dir, 'dockerd'), FAKE_DOCKERD, { mode: 0o755 })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function docker(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync('bash', [SHIM, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      FAKE_DIR: dir,
      ORCA_REAL_DOCKER: join(dir, 'docker'),
      ORCA_DOCKERD: join(dir, 'dockerd'),
      ORCA_DOCKER_SUDO: '',
      ORCA_DOCKERD_LOG: join(dir, 'dockerd.log'),
      ORCA_DOCKER_LOCK: join(dir, 'dockerd.lock'),
      ORCA_DOCKER_WAIT_TICKS: '40',
      ...extra
    }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const starts = (): number =>
  existsSync(join(dir, 'starts')) ? readFileSync(join(dir, 'starts'), 'utf8').trim().split('\n').length : 0

describe('the docker shim (PARITY-DOCKER)', () => {
  it('starts dockerd on the first command, says what differs once, then runs plain docker', () => {
    const first = docker(['run', '--rm', 'hello-world'])
    expect(first.status).toBe(0)
    expect(first.stdout).toBe('real docker run --rm hello-world\n')
    expect(starts()).toBe(1)
    expect(first.stderr).toContain('Running containers stop when the workspace sleeps')
    expect(first.stderr).toContain('vercel-proxy-ca.pem')

    // Daemon up: no second start, no notice.
    const again = docker(['ps'])
    expect(again.stdout).toBe('real docker ps\n')
    expect(again.stderr).toBe('')
    expect(starts()).toBe(1)
  })

  it('never starts the daemon for --version, help, or a DOCKER_HOST elsewhere', () => {
    expect(docker(['--version']).stdout).toBe('real docker --version\n')
    expect(docker(['help']).stdout).toBe('real docker help\n')
    expect(docker(['ps'], { DOCKER_HOST: 'tcp://elsewhere:2375' }).stdout).toBe('real docker ps\n')
    expect(starts()).toBe(0)
  })

  it('says so when dockerd never comes up, with where its log is', () => {
    const failed = docker(['ps'], { FAKE_NEVER_UP: '1' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("Docker didn't start in this workspace")
    expect(failed.stderr).toContain('dockerd.log')
    expect(failed.stdout).toBe('')
  })

  it('a workspace from an image without Docker says so instead of waiting on a daemon', () => {
    const missing = docker(['ps'], { ORCA_REAL_DOCKER: join(dir, 'no-such-docker') })
    expect(missing.status).toBe(127)
    expect(missing.stderr).toContain('created before Orca Cloud had Docker')
    expect(starts()).toBe(0)
  })

  it('turned off by the control plane: refuses with a plain message and starts nothing', () => {
    writeFileSync(join(home, '.orca-sandbox', 'docker.off'), '')
    const refused = docker(['run', 'redis'])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toBe('orca: Docker is turned off for Orca Cloud workspaces right now.\n')
    expect(refused.stdout).toBe('')
    expect(starts()).toBe(0)
  })
})
