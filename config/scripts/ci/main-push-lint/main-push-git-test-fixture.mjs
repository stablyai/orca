// Real Git repositories for the main-push lint tests: an origin to push to and depth-1 checkouts of it, as in Actions.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '../../../..')
export const DEBUGGER = 'debugger\n'
export const CLEAN = 'export {}\n'
export const CONFIG = JSON.stringify({ rules: { 'no-debugger': 'error' } })
// Each test runs dozens of short Git and oxlint processes; on a loaded runner that outlasts the default timeout.
export const GIT_TEST_TIMEOUT_MS = 120_000
export const LENIENT = JSON.stringify({ rules: { 'no-debugger': 'off' } })

export function createGitFixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'orca-main-push-lint-'))
  let counter = 0

  function git(cwd, ...args) {
    return execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args
      ],
      { cwd, encoding: 'utf8' }
    ).trim()
  }

  // Writes each file (null deletes it), commits everything, and returns the new SHA.
  function commit(cwd, files, message) {
    for (const [file, content] of Object.entries(files)) {
      if (content === null) {
        rmSync(join(cwd, file))
      } else {
        mkdirSync(dirname(join(cwd, file)), { recursive: true })
        writeFileSync(join(cwd, file), content)
      }
    }
    // --force: a test may track a file its own .gitignore matches, as Orca does.
    git(cwd, 'add', '-A', '--force')
    git(cwd, 'commit', '-q', '--allow-empty', '-m', message)
    return git(cwd, 'rev-parse', 'HEAD')
  }

  function makeOrigin() {
    const origin = join(scratch, `origin-${counter++}`)
    git(scratch, 'init', '-q', '-b', 'main', origin)
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
    return origin
  }

  // The Actions checkout: one commit deep at the pushed SHA, so the push base must be fetched.
  function shallowCheckout(origin, sha) {
    const checkout = join(scratch, `checkout-${counter++}`)
    git(scratch, 'clone', '-q', '--depth=1', '--no-local', `file://${origin}`, checkout)
    if (sha) {
      git(checkout, 'fetch', '-q', '--depth=1', 'origin', sha)
      git(checkout, 'checkout', '-q', '--detach', sha)
    }
    return checkout
  }

  function scratchFile(name) {
    return join(scratch, `${name}-${counter++}`)
  }

  return {
    git,
    commit,
    makeOrigin,
    shallowCheckout,
    scratchFile,
    cleanup: () => rmSync(scratch, { recursive: true, force: true })
  }
}
