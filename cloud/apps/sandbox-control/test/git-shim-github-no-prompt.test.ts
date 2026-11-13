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
    if [ "\${GIT_TERMINAL_PROMPT:-}" = 0 ]; then
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

function git(args: string[], remoteUrl: string): string {
  const result = spawnSync('bash', [SHIM, ...args], {
    cwd: home,
    env: { PATH: '/usr/bin:/bin', HOME: home, ORCA_REAL_GIT: fakeGit, FAKE_REMOTE_URL: remoteUrl, ORCA_GIT_NUDGE_DIR: home },
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
      "orca: Orca Cloud can't push to octocat/Hello-World. Install the Orca GitHub App on octocat, or connect your GitHub in Settings › Account & billing."
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
})
