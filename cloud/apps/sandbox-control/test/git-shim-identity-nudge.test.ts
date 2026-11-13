// #503 follow-up (design-squad): a commit that goes out under the workspace identity (Orca Cloud's
// name) says once per session how to use your own: connect GitHub in Settings → Account.
// Pushes and read-only git never say it; orca-git-as's own fallback line is replaced by it.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SHIM = fileURLToPath(new URL('../image/vm/git', import.meta.url).href)
const NUDGE = "orca: This commit is authored as Orca <noreply@orca.dev>. Connect GitHub in Settings → Account to commit as yourself."

let home = ''
let cwd = ''
let shm = ''
let gitAs = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-git-nudge-'))
  mkdirSync(join(home, '.orca-sandbox'))
  cwd = mkdtempSync(join(tmpdir(), 'orca-git-nudge-cwd-'))
  shm = mkdtempSync(join(tmpdir(), 'orca-git-nudge-shm-'))
  gitAs = join(home, 'orca-git-as')
})

afterEach(() => {
  for (const dir of [home, cwd, shm]) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A stand-in orca-git-as: `fallback` prints its no-identity line, `member` prints nothing. */
function fakeGitAs(mode: 'fallback' | 'member'): void {
  const line = mode === 'fallback' ? "echo 'orca-git-as: no teammate identity for this turn; using the workspace identity' >&2" : ''
  writeFileSync(gitAs, `#!/usr/bin/env bash\n${line}\necho 'git-as ran' >&2\nexit 0\n`)
  chmodSync(gitAs, 0o755)
}

function git(args: string[], extra: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync('bash', [SHIM, ...args], {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: home, ORCA_GIT_NUDGE_DIR: shm, ORCA_GIT_AS: gitAs, ...extra },
    encoding: 'utf8'
  })
  return result.stderr
}

const nudges = (stderr: string): number => stderr.split('\n').filter((l) => l === NUDGE).length

describe('the git shim identity nudge', () => {
  it('a commit with no terminal or agent turn says it once per session', () => {
    expect(nudges(git(['commit', '-m', 'x']))).toBe(1)
    expect(nudges(git(['commit', '-m', 'y']))).toBe(0)
  })

  it('replaces orca-git-as’s fallback line in a plain terminal, once', () => {
    fakeGitAs('fallback')
    const first = git(['commit', '-m', 'x'], { ORCA_TERMINAL_HANDLE: 'h1' })
    expect(nudges(first)).toBe(1)
    expect(first).not.toContain('no teammate identity')
    expect(first).toContain('git-as ran')
    expect(nudges(git(['commit', '-m', 'y'], { ORCA_TERMINAL_HANDLE: 'h1' }))).toBe(0)
  })

  it('says nothing when the commit runs as a connected member', () => {
    fakeGitAs('member')
    const run = git(['commit', '-m', 'x'], { ORCA_TERMINAL_HANDLE: 'h1' })
    expect(nudges(run)).toBe(0)
    expect(run).toContain('git-as ran')
  })

  it('never nudges on push or read-only git', () => {
    fakeGitAs('fallback')
    expect(nudges(git(['push', 'origin', 'HEAD'], { ORCA_TERMINAL_HANDLE: 'h1' }))).toBe(0)
    expect(nudges(git(['status']))).toBe(0)
    expect(nudges(git(['commit', '-m', 'x']))).toBe(1)
  })
})
