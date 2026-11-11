// CREATE-GIT-ASYNC: the VM's `git` shim (image/vm/git) holds commits and pushes while a new
// workspace's member identities are still being installed, and stops them with what to do when that
// setup failed or stalled. Read-only git never waits.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SHIM = fileURLToPath(new URL('../image/vm/git', import.meta.url).href)

let home = ''
let state = ''
let cwd = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-git-shim-'))
  state = join(home, '.orca-sandbox')
  mkdirSync(state)
  // Not a repository: a command the shim lets through reaches real git, which says so.
  cwd = mkdtempSync(join(tmpdir(), 'orca-git-shim-cwd-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const now = (): number => Math.floor(Date.now() / 1000)
const env = (ticks?: number): NodeJS.ProcessEnv => ({
  PATH: '/usr/bin:/bin',
  HOME: home,
  ...(ticks === undefined ? {} : { ORCA_GIT_SETUP_WAIT_TICKS: String(ticks) })
})

function git(args: string[], ticks?: number): { status: number | null; stderr: string; ms: number } {
  const started = Date.now()
  const result = spawnSync('bash', [SHIM, ...args], { cwd, env: env(ticks), encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr, ms: Date.now() - started }
}

const reachedRealGit = (stderr: string): boolean => /not a git repository/i.test(stderr)

describe('the git shim while member setup is pending', () => {
  it('passes straight through when no setup is pending (wake, restart, older creates)', () => {
    expect(reachedRealGit(git(['commit', '-m', 'x']).stderr)).toBe(true)
  })

  it('never holds read-only git, even while setup is pending', () => {
    writeFileSync(join(state, 'git-setup.pending'), `${now()}\n`)
    const run = git(['status'], 50)
    expect(reachedRealGit(run.stderr)).toBe(true)
    expect(run.ms).toBeLessThan(2_000)
  })

  it('holds a push until setup turns ready, then runs it (not raced)', async () => {
    writeFileSync(join(state, 'git-setup.pending'), `${now()}\n`)
    const started = Date.now()
    const child = spawn('bash', [SHIM, 'push', 'origin', 'HEAD'], { cwd, env: env() })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    setTimeout(() => writeFileSync(join(state, 'git-setup.ready'), `${now()}\n`), 700)
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(Date.now() - started).toBeGreaterThanOrEqual(600)
    expect(status).not.toBe(1)
    expect(reachedRealGit(stderr)).toBe(true)
  })

  it('stops a commit with what to do when setup failed', () => {
    writeFileSync(join(state, 'git-setup.pending'), `${now()}\n`)
    writeFileSync(join(state, 'git-setup.failed'), `${now()}\n`)
    const run = git(['commit', '-m', 'x'])
    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      "orca: Orca couldn't set up your GitHub identity in this sandbox, so it stopped `git commit` rather than use the wrong identity. Restart this workspace (right-click it in the sidebar > Restart), then try again.\n"
    )
    expect(reachedRealGit(run.stderr)).toBe(false)
  })

  it('gives up after its wait instead of blocking forever, and says so', () => {
    writeFileSync(join(state, 'git-setup.pending'), `${now()}\n`)
    const run = git(['push'], 5)
    expect(run.status).toBe(1)
    expect(run.stderr).toBe(
      'orca: Orca is still setting up your GitHub identity in this sandbox, so it stopped `git push` rather than use the wrong identity. Try again in a few seconds. If this keeps happening, restart this workspace (right-click it in the sidebar > Restart).\n'
    )
    expect(run.ms).toBeLessThan(5_000)
  })

  it('does not wait on a stale mark from a setup that died', () => {
    writeFileSync(join(state, 'git-setup.pending'), `${now() - 600}\n`)
    const run = git(['push'])
    expect(run.status).toBe(1)
    expect(run.ms).toBeLessThan(2_000)
  })
})
