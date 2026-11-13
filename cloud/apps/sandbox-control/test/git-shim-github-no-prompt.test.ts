// PUSH-RAW-PROMPT: a push, pull or fetch to a github.com repo that no credential covers never reaches git's own
// "Username for 'https://github.com':" prompt. The shim turns prompts off for github.com remotes and replaces
// git's auth failure with one plain line. Other hosts and other failures are untouched.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SHIM = fileURLToPath(new URL('../image/vm/git', import.meta.url).href)

let home = ''
let fakeGit = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-git-noprompt-'))
  mkdirSync(join(home, '.orca-sandbox'))
  fakeGit = join(home, 'git')
  // A stand-in for /usr/bin/git: answers `remote get-url` from FAKE_REMOTE_URL and fails a network command the
  // way real git does with no credential: a prompt when prompts are allowed, the "could not read" error when not.
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env bash
case "$1" in
  remote) [ "$2" = get-url ] && { printf '%s\\n' "$FAKE_REMOTE_URL"; exit 0; } ;;
  config | symbolic-ref) exit 1 ;;
  push | pull | fetch)
    echo "GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT:-unset}" >&2
    if [ -n "\${FAKE_413:-}" ]; then
      echo "error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413" >&2
      echo "send-pack: unexpected disconnect while reading sideband packet" >&2
      echo "fatal: the remote end hung up unexpectedly" >&2
    elif [ -n "\${FAKE_NOT_FOUND:-}" ]; then
      echo "remote: Repository not found." >&2
      echo "fatal: repository 'https://github.com/acme/typo.git/' not found" >&2
    elif [ "\${GIT_TERMINAL_PROMPT:-}" = 0 ]; then
      echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2
    else
      printf "Username for 'https://github.com': " >&2
    fi
    exit 128 ;;
esac
exit 0
`
  )
  chmodSync(fakeGit, 0o755)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function git(args: string[], remoteUrl: string, extra: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync('bash', [SHIM, ...args], {
    cwd: home,
    env: { PATH: '/usr/bin:/bin', HOME: home, ORCA_REAL_GIT: fakeGit, FAKE_REMOTE_URL: remoteUrl, ORCA_GIT_NUDGE_DIR: home, ...extra },
    encoding: 'utf8'
  })
  return result.stderr
}

describe('the git shim never lets a github.com push prompt for credentials', () => {
  it('push to an uncovered github.com repo: prompts off, one plain line instead of git’s error', () => {
    const err = git(['push', 'origin', 'HEAD'], 'https://github.com/octocat/Hello-World.git')
    expect(err).toContain('GIT_TERMINAL_PROMPT=0')
    expect(err).not.toContain("Username for 'https://github.com'")
    expect(err).not.toContain('could not read Username')
    expect(err).toContain(
      "orca: Orca Cloud can't push to octocat/Hello-World. Install the Orca GitHub App on octocat, or connect your GitHub in Settings → Account."
    )
  })

  it('fetch and pull say "read" and work with the default remote', () => {
    expect(git(['fetch'], 'https://github.com/octocat/Hello-World')).toContain("orca: Orca Cloud can't read octocat/Hello-World.")
    expect(git(['pull'], 'https://x-access-token@github.com/acme/app.git')).toContain("orca: Orca Cloud can't read acme/app.")
  })

  it('a push to a non-GitHub remote is untouched (its own prompt, no orca line)', () => {
    const err = git(['push', 'origin', 'HEAD'], 'https://gitlab.com/acme/app.git')
    expect(err).toContain('GIT_TERMINAL_PROMPT=unset')
    expect(err).not.toContain('orca:')
  })

  it('a push straight to a github.com URL is covered too', () => {
    const err = git(['push', 'https://github.com/acme/app', 'HEAD'], '')
    expect(err).toContain("orca: Orca Cloud can't push to acme/app.")
  })

  it("GitHub's not-found says to check the name, or install the App if it's private (once)", () => {
    const err = git(['push', 'origin', 'HEAD'], 'https://github.com/acme/typo.git', { FAKE_NOT_FOUND: '1' })
    expect(err).toContain("orca: Orca Cloud can't find acme/typo. Check the name, or install the Orca GitHub App on acme if it's private.")
    expect(err).not.toContain('Repository not found')
    expect(err.split('\n').filter((l) => l.startsWith('orca:')).length).toBe(1)
  })

  it('PUSH-CAP: a push over the egress proxy\u2019s size cap says so in plain words, once, instead of a bare 413', () => {
    const err = git(['push', 'origin', 'HEAD'], 'https://github.com/acme/app.git', { FAKE_413: '1' })
    const line =
      'orca: This push is too large for Orca Cloud right now (about 100 MB per push). Push it in smaller parts, for example `git push origin HEAD~5:<branch>` first, then `git push` again.'
    expect(err.split('\n').filter((l) => l === line)).toHaveLength(1)
    expect(err).not.toContain('HTTP 413')
    expect(err).not.toContain('returned error: 413')
    // git's own follow-up lines stay, and nothing claims an access problem.
    expect(err).toContain('fatal: the remote end hung up unexpectedly')
    expect(err).not.toContain("can't push to")
  })

  it('PUSH-CAP: a 413 from a non-GitHub remote is left as git printed it', () => {
    const err = git(['push', 'origin', 'HEAD'], 'https://gitlab.com/acme/app.git', { FAKE_413: '1' })
    expect(err).toContain('HTTP 413')
    expect(err).not.toContain('orca:')
  })
})
