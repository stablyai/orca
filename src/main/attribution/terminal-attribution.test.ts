/* eslint-disable max-lines -- Why: these tests exercise generated shell wrapper
scripts end-to-end, and keeping the regression fixtures adjacent makes the
attribution safety cases easier to audit. */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTerminalAttributionEnv } from './terminal-attribution'

describe('applyTerminalAttributionEnv', () => {
  let tmpRoot: string | null = null

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { force: true, recursive: true })
      tmpRoot = null
    }
  })

  function makeTmpRoot(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), 'orca-attribution-'))
    return tmpRoot
  }

  function runGit(repo: string, args: string[], env?: Record<string, string>): string {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...getCleanProcessEnv(), ...env }
    })
  }

  function getCleanProcessEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    delete env.ORCA_ENABLE_GIT_ATTRIBUTION
    delete env.ORCA_GIT_COMMIT_TRAILER
    delete env.ORCA_GH_PR_FOOTER
    delete env.ORCA_GH_ISSUE_FOOTER
    delete env.ORCA_ATTRIBUTION_SHIM_DIR
    delete env.ORCA_REAL_GIT
    delete env.ORCA_REAL_GH
    env.PATH = (env.PATH ?? '')
      .split(process.platform === 'win32' ? ';' : ':')
      .filter((entry) => !entry.replace(/\\/g, '/').includes('/orca-terminal-attribution/'))
      .join(process.platform === 'win32' ? ';' : ':')
    return env
  }

  it('does not amend HEAD when git commit --dry-run exits successfully', () => {
    const root = makeTmpRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    runGit(repo, ['init'])
    runGit(repo, ['config', 'user.name', 'Orca Test'])
    runGit(repo, ['config', 'user.email', 'orca-test@example.com'])
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    runGit(repo, ['add', 'README.md'])
    runGit(repo, ['commit', '-m', 'initial'])

    const attributionEnv = { PATH: process.env.PATH ?? '' }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })
    const beforeHead = runGit(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'second.txt'), 'second\n')
    runGit(repo, ['add', 'second.txt'])

    // Why: dry-run reports what would be committed but must not rewrite the
    // existing HEAD just because the real git command returns success.
    runGit(repo, ['commit', '--dry-run', '-m', 'second'], attributionEnv)

    expect(runGit(repo, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead)
    expect(runGit(repo, ['log', '-1', '--format=%B'])).not.toContain('Co-authored-by: Orca')

    runGit(repo, ['commit', '-m', 'second'], attributionEnv)
    expect(runGit(repo, ['rev-parse', 'HEAD']).trim()).not.toBe(beforeHead)
    expect(runGit(repo, ['log', '-1', '--format=%B'])).toContain(
      'Co-authored-by: Orca <help@stably.ai>'
    )
  })

  it('still adds the trailer when git commit uses --no-verify shorthand', () => {
    const root = makeTmpRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    runGit(repo, ['init'])
    runGit(repo, ['config', 'user.name', 'Orca Test'])
    runGit(repo, ['config', 'user.email', 'orca-test@example.com'])
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    runGit(repo, ['add', 'README.md'])

    const attributionEnv = { PATH: process.env.PATH ?? '' }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    runGit(repo, ['commit', '-n', '-m', 'initial'], attributionEnv)

    expect(runGit(repo, ['log', '-1', '--format=%B'])).toContain(
      'Co-authored-by: Orca <help@stably.ai>'
    )
  })

  it('adds the trailer when git commit uses combined -am shorthand', () => {
    const root = makeTmpRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    runGit(repo, ['init'])
    runGit(repo, ['config', 'user.name', 'Orca Test'])
    runGit(repo, ['config', 'user.email', 'orca-test@example.com'])
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    runGit(repo, ['add', 'README.md'])
    runGit(repo, ['commit', '-m', 'initial'])
    writeFileSync(join(repo, 'README.md'), 'changed\n')

    const attributionEnv = { PATH: process.env.PATH ?? '' }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    runGit(repo, ['commit', '-am', 'combined message'], attributionEnv)

    expect(runGit(repo, ['log', '-1', '--format=%B'])).toContain(
      'Co-authored-by: Orca <help@stably.ai>'
    )
  })

  it('adds the trailer when git commit follows global git config args', () => {
    const root = makeTmpRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    runGit(repo, ['init'])
    runGit(repo, ['config', 'user.name', 'Orca Test'])
    runGit(repo, ['config', 'user.email', 'orca-test@example.com'])
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    runGit(repo, ['add', 'README.md'])

    const attributionEnv = { PATH: process.env.PATH ?? '' }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    runGit(repo, ['-c', 'core.quotePath=false', 'commit', '-m', 'initial'], attributionEnv)

    expect(runGit(repo, ['log', '-1', '--format=%B'])).toContain(
      'Co-authored-by: Orca <help@stably.ai>'
    )
  })

  it('adds the trailer to commit message files before git runs', () => {
    const root = makeTmpRoot()
    const repo = join(root, 'repo')
    const messagePath = join(root, 'message.txt')
    mkdirSync(repo)
    runGit(repo, ['init'])
    runGit(repo, ['config', 'user.name', 'Orca Test'])
    runGit(repo, ['config', 'user.email', 'orca-test@example.com'])
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    writeFileSync(messagePath, 'initial from file\n')
    runGit(repo, ['add', 'README.md'])

    const attributionEnv = { PATH: process.env.PATH ?? '' }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    runGit(repo, ['commit', '-F', messagePath], attributionEnv)

    expect(runGit(repo, ['log', '-1', '--format=%B'])).toContain(
      'Co-authored-by: Orca <help@stably.ai>'
    )
    expect(readFileSync(messagePath, 'utf8')).toBe('initial from file\n')
  })

  it('passes missing commit message files through without adding fallback message args', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const argsPath = join(root, 'commit-args')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'git'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "commit" ]]; then
  printf '%s\\n' "$@" >"${argsPath}"
  exit 9
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const attributionEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    expect(() =>
      execFileSync('git', ['commit', '-F', join(root, 'missing-message.txt')], {
        encoding: 'utf8',
        env: { ...process.env, ...attributionEnv }
      })
    ).toThrow()

    expect(readFileSync(argsPath, 'utf8')).not.toContain('Co-authored-by: Orca')
  })

  it('passes reuse and fixup commit message modes through without attribution', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const argsPath = join(root, 'commit-args')
    const messagePath = join(root, 'message.txt')
    mkdirSync(binDir)
    writeFileSync(messagePath, 'from file\n')
    writeFileSync(
      join(binDir, 'git'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "commit" ]]; then
  printf '%s\\n' "$@" >>"${argsPath}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const attributionEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    execFileSync('git', ['commit', '-C', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })
    execFileSync('git', ['commit', '--fixup', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })
    execFileSync('git', ['commit', '-F', messagePath, '--fixup', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })

    expect(readFileSync(argsPath, 'utf8')).not.toContain('Co-authored-by: Orca')
  })

  it('adds the trailer before commit-msg hooks validate the commit', () => {
    const root = makeTmpRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    runGit(repo, ['init'])
    runGit(repo, ['config', 'user.name', 'Orca Test'])
    runGit(repo, ['config', 'user.email', 'orca-test@example.com'])
    const hookPath = join(repo, '.git', 'hooks', 'commit-msg')
    const hookCounterPath = join(repo, 'hook-count')
    writeFileSync(
      hookPath,
      `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f "${hookCounterPath}" ]]; then
  count="$(cat "${hookCounterPath}")"
fi
printf '%s\\n' "$((count + 1))" >"${hookCounterPath}"
grep -Fq 'Co-authored-by: Orca <help@stably.ai>' "$1"
`,
      'utf8'
    )
    chmodSync(hookPath, 0o755)
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    runGit(repo, ['add', 'README.md'])

    const attributionEnv = { PATH: process.env.PATH ?? '' }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    runGit(repo, ['commit', '-m', 'initial'], attributionEnv)

    expect(readFileSync(hookCounterPath, 'utf8').trim()).toBe('1')
    expect(runGit(repo, ['log', '-1', '--format=%B'])).toContain(
      'Co-authored-by: Orca <help@stably.ai>'
    )
  })

  it('adds git attribution to the original commit command without amending', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const commitPath = join(root, 'commit-called')
    const amendPath = join(root, 'amend-called')
    const argsPath = join(root, 'commit-args')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'git'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2 $3" == "config --bool commit.gpgsign" ]]; then
  printf '%s\\n' 'true'
  exit 0
fi
if [[ "$1" == "commit" ]]; then
  if [[ "\${2:-}" == "--amend" ]]; then
    touch "${amendPath}"
  else
    printf '%s\\n' "$@" >"${argsPath}"
    touch "${commitPath}"
  fi
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const attributionEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    execFileSync('git', ['commit', '-m', 'signed commit'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })

    expect(existsSync(commitPath)).toBe(true)
    expect(existsSync(amendPath)).toBe(false)
    expect(readFileSync(argsPath, 'utf8')).toContain('Co-authored-by: Orca <help@stably.ai>')
  })

  it('passes editor-based commits through without attribution', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const argsPath = join(root, 'commit-args')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'git'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "commit" ]]; then
  printf '%s\\n' "$@" >"${argsPath}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const attributionEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    execFileSync('git', ['commit'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })

    expect(readFileSync(argsPath, 'utf8')).toBe('commit\n')
  })

  it('preserves interactive gh pr create without guessing which PR to edit', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const markerPath = join(root, 'gh-edit-called')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "pr create" ]]; then
  printf '%s\\n' 'interactive create complete'
  exit 0
fi
if [[ "$1 $2 $3 $4" == "pr view --json url" ]]; then
  printf '%s\\n' 'https://github.com/stablyai/orca/pull/123'
  exit 0
fi
if [[ "$1 $2" == "api repos/stablyai/orca/pulls/123" && "\${3:-}" == "--jq" ]]; then
  printf '%s\\n' 'Existing body'
  exit 0
fi
if [[ "$1 $2 $3 $4" == "api -X PATCH repos/stablyai/orca/pulls/123" ]]; then
  touch "${markerPath}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    const output = execFileSync('gh', ['pr', 'create'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })

    expect(output).toBe('interactive create complete\n')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('adds gh attribution for noninteractive create output URLs', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const prMarkerPath = join(root, 'pr-edit-called')
    const issueMarkerPath = join(root, 'issue-edit-called')
    const patchArgsPath = join(root, 'patch-args')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "pr create" ]]; then
  printf '%s\\n' 'https://github.com/stablyai/orca/pull/123'
  exit 0
fi
if [[ "$1 $2" == "issue create" ]]; then
  printf '%s\\n' 'https://github.com/stablyai/orca/issues/456'
  exit 0
fi
if [[ "$1 $2" == "api repos/stablyai/orca/pulls/123" && "\${3:-}" == "--jq" ]]; then
  printf '%s\\n' 'PR body'
  exit 0
fi
if [[ "$1 $2" == "api repos/stablyai/orca/issues/456" && "\${3:-}" == "--jq" ]]; then
  printf '%s\\n' 'Issue body'
  exit 0
fi
if [[ "$1 $2 $3 $4" == "api -X PATCH repos/stablyai/orca/pulls/123" ]]; then
  printf '%s\\n' "$@" >"${patchArgsPath}"
  touch "${prMarkerPath}"
  exit 0
fi
if [[ "$1 $2 $3 $4" == "api -X PATCH repos/stablyai/orca/issues/456" ]]; then
  touch "${issueMarkerPath}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    expect(
      execFileSync('gh', ['pr', 'create', '--fill'], {
        encoding: 'utf8',
        env: { ...process.env, ...attributionEnv }
      })
    ).toBe('https://github.com/stablyai/orca/pull/123\n')
    expect(
      execFileSync('gh', ['issue', 'create', '--title', 'Issue', '--body', 'Body'], {
        encoding: 'utf8',
        env: { ...process.env, ...attributionEnv }
      })
    ).toBe('https://github.com/stablyai/orca/issues/456\n')

    expect(existsSync(prMarkerPath)).toBe(true)
    expect(existsSync(issueMarkerPath)).toBe(true)
    expect(readFileSync(patchArgsPath, 'utf8')).toContain('body=@')
    expect(readFileSync(patchArgsPath, 'utf8')).not.toContain('PR body')
  })

  it('passes gh create help through without editing existing PRs or issues', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const markerPath = join(root, 'gh-edit-called')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2 $3" == "pr create --help" ]]; then
  printf '%s\\n' 'pr help'
  exit 0
fi
if [[ "$1 $2 $3" == "issue create --help" ]]; then
  printf '%s\\n' 'issue help'
  exit 0
fi
if [[ "$1 $2 $3 $4" == "pr view --json url" ]]; then
  printf '%s\\n' 'https://github.com/stablyai/orca/pull/123'
  exit 0
fi
if [[ "$1 $2" == "issue list" ]]; then
  printf '%s\\n' 'https://github.com/stablyai/orca/issues/456'
  exit 0
fi
if [[ "$1 $2 $3 $4" == "api -X PATCH repos/stablyai/orca/pulls/123" ]]; then
  touch "${markerPath}"
  exit 0
fi
if [[ "$1 $2 $3 $4" == "api -X PATCH repos/stablyai/orca/issues/456" ]]; then
  touch "${markerPath}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    const output = execFileSync('gh', ['pr', 'create', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })

    expect(output).toBe('pr help\n')
    const issueOutput = execFileSync('gh', ['issue', 'create', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })

    expect(issueOutput).toBe('issue help\n')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('preserves interactive gh issue create without guessing which issue to edit', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const markerPath = join(root, 'gh-edit-called')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "issue create" ]]; then
  printf '%s\\n' 'interactive issue create complete'
  exit 0
fi
if [[ "$1 $2" == "issue list" ]]; then
  printf '%s\\n' 'https://github.com/stablyai/orca/issues/456'
  exit 0
fi
if [[ "$1 $2 $3 $4" == "api -X PATCH repos/stablyai/orca/issues/456" ]]; then
  touch "${markerPath}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    const output = execFileSync('gh', ['issue', 'create'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })

    expect(output).toBe('interactive issue create complete\n')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('skips gh attribution edits when viewing the created item fails', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const markerPath = join(root, 'gh-edit-called')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "pr create" ]]; then
  printf '%s\\n' 'https://github.com/stablyai/orca/pull/123'
  exit 0
fi
if [[ "$1 $2" == "api repos/stablyai/orca/pulls/123" && "\${3:-}" == "--jq" ]]; then
  exit 7
fi
if [[ "$1 $2 $3 $4" == "api -X PATCH repos/stablyai/orca/pulls/123" ]]; then
  touch "${markerPath}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    const output = execFileSync('gh', ['pr', 'create', '--fill'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })

    expect(output).toBe('https://github.com/stablyai/orca/pull/123\n')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('keeps gh create successful when the attribution edit fails', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "pr create" ]]; then
  printf '%s\\n' 'https://github.com/stablyai/orca/pull/123'
  exit 0
fi
if [[ "$1 $2" == "api repos/stablyai/orca/pulls/123" && "\${3:-}" == "--jq" ]]; then
  printf '%s\\n' 'Existing body'
  exit 0
fi
if [[ "$1 $2 $3 $4" == "api -X PATCH repos/stablyai/orca/pulls/123" ]]; then
  exit 9
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}` }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    const output = execFileSync('gh', ['pr', 'create', '--fill'], {
      encoding: 'utf8',
      env: { ...process.env, ...attributionEnv }
    })

    expect(output).toBe('https://github.com/stablyai/orca/pull/123\n')
  })

  it('fails open when shim files cannot be written', () => {
    const root = makeTmpRoot()
    const blockedUserDataPath = join(root, 'not-a-directory')
    writeFileSync(blockedUserDataPath, 'blocked\n')
    const baseEnv: Record<string, string> = { PATH: '/usr/bin' }

    applyTerminalAttributionEnv(baseEnv, {
      enabled: true,
      userDataPath: blockedUserDataPath
    })

    expect(baseEnv.ORCA_ENABLE_GIT_ATTRIBUTION).toBeUndefined()
    expect(baseEnv.PATH).toBe('/usr/bin')
  })

  it('does not duplicate shim directories when applied to an already-injected env', () => {
    const root = makeTmpRoot()
    const baseEnv: Record<string, string> = { PATH: process.env.PATH ?? '' }
    const options = { enabled: true, userDataPath: join(root, 'user-data') }
    const pathDelimiter = process.platform === 'win32' ? ';' : ':'

    applyTerminalAttributionEnv(baseEnv, options)
    applyTerminalAttributionEnv(baseEnv, options)

    const shimEntries = baseEnv.PATH.split(pathDelimiter).filter((entry) =>
      entry.includes('orca-terminal-attribution')
    )
    expect(new Set(shimEntries).size).toBe(shimEntries.length)
  })

  it('writes PowerShell wrappers without raw-template backslash escapes', () => {
    const root = makeTmpRoot()
    applyTerminalAttributionEnv(
      { PATH: process.env.PATH ?? '' },
      { enabled: true, userDataPath: join(root, 'user-data') }
    )

    const shimDir = join(root, 'user-data', 'orca-terminal-attribution', 'win32')
    const gitWrapper = readFileSync(join(shimDir, 'git-wrapper.ps1'), 'utf8')
    const ghWrapper = readFileSync(join(shimDir, 'gh-wrapper.ps1'), 'utf8')

    expect(gitWrapper).toContain('Test-ExplicitCommitMessage')
    expect(gitWrapper).toContain('"`r`n`r`n"')
    expect(ghWrapper).toContain('$body.TrimEnd("`r", "`n")')
    expect(ghWrapper).toContain('"`r`n`r`n"')
    expect(gitWrapper).not.toContain('"\\`r"')
    expect(ghWrapper).not.toContain('"\\`r"')
  })
})
