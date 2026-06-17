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
import { applyTerminalAttributionEnv, resolveAttributionShellFamily } from './terminal-attribution'

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

  function stripInheritedAttributionPath(pathValue: string): string {
    const pathDelimiter = process.platform === 'win32' ? ';' : ':'
    return pathValue
      .split(pathDelimiter)
      .filter((entry) => !entry.includes('orca-terminal-attribution'))
      .join(pathDelimiter)
  }

  function cleanAttributionEnv(env?: Record<string, string>): Record<string, string> {
    const base = { ...process.env }
    delete base.ORCA_ENABLE_GIT_ATTRIBUTION
    delete base.ORCA_GIT_COMMIT_TRAILER
    delete base.ORCA_GH_PR_FOOTER
    delete base.ORCA_GH_ISSUE_FOOTER
    delete base.ORCA_ATTRIBUTION_SHIM_DIR
    delete base.ORCA_REAL_GIT
    delete base.ORCA_REAL_GH
    base.PATH = stripInheritedAttributionPath(base.PATH ?? '')
    const next = { ...base, ...env }
    return next as Record<string, string>
  }

  function runGit(repo: string, args: string[], env?: Record<string, string>): string {
    return execToolSync('git', args, { cwd: repo, env })
  }

  function execToolSync(
    tool: 'git' | 'gh',
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): string {
    const env = cleanAttributionEnv(options.env)
    const invocation = resolveToolInvocation(tool, args, env)
    return execFileSync(invocation.command, invocation.args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env
    })
  }

  function resolveToolInvocation(
    tool: 'git' | 'gh',
    args: string[],
    env: Record<string, string>
  ): { command: string; args: string[] } {
    if (process.platform !== 'win32' || env.ORCA_ENABLE_GIT_ATTRIBUTION !== '1') {
      return { command: tool, args }
    }
    const shimDir = (env.PATH ?? '').split(';')[0]
    const shimPath = shimDir ? join(shimDir, `${tool}.cmd`) : ''
    if (!shimPath || !existsSync(shimPath)) {
      return { command: tool, args }
    }
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/c', shimPath, ...args]
    }
  }

  function pathWithToolDir(binDir: string): string {
    const pathDelimiter = process.platform === 'win32' ? ';' : ':'
    return [binDir, stripInheritedAttributionPath(process.env.PATH ?? '')]
      .filter(Boolean)
      .join(pathDelimiter)
  }

  function bashPath(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/')
    const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalized)
    if (!driveMatch) {
      return normalized
    }
    return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`
  }

  function gitBashPath(filePath: string): string {
    return filePath.replace(/\\/g, '/')
  }

  function normalizeToolOutput(value: string): string {
    return value.replace(/\r\n/g, '\n')
  }

  function writeFakeTool(
    binDir: string,
    tool: 'git' | 'gh',
    script: string,
    encoding: BufferEncoding = 'utf8'
  ): void {
    const scriptPath = join(binDir, tool)
    writeFileSync(scriptPath, script, encoding)
    if (process.platform !== 'win32') {
      chmodSync(scriptPath, 0o755)
      return
    }
    const runnerPath = join(binDir, `${tool}-runner.cjs`)
    writeFileSync(
      runnerPath,
      [
        "const { spawnSync } = require('node:child_process')",
        'const scriptPath = process.argv[2]',
        'const args = process.argv.slice(3)',
        "const wslPath = '/mnt/' + scriptPath[0].toLowerCase() + scriptPath.slice(2).replace(/\\\\/g, '/')",
        "const result = spawnSync('bash', [wslPath, ...args], { stdio: 'inherit' })",
        'process.exit(result.status ?? 1)',
        ''
      ].join('\n')
    )
    writeFileSync(
      join(binDir, `${tool}.cmd`),
      `@echo off\r\nnode "%~dp0${tool}-runner.cjs" "%~dp0${tool}" %*\r\n`
    )
  }

  it('classifies Windows native and POSIX shell families for attribution shims', () => {
    expect(resolveAttributionShellFamily({ platform: 'win32', shellPath: 'powershell.exe' })).toBe(
      'native-windows'
    )
    expect(resolveAttributionShellFamily({ platform: 'win32', shellPath: 'cmd.exe' })).toBe(
      'native-windows'
    )
    expect(
      resolveAttributionShellFamily({
        platform: 'win32',
        shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe'
      })
    ).toBe('posix')
    expect(resolveAttributionShellFamily({ platform: 'win32', shellPath: 'wsl.exe' })).toBe('posix')
    expect(resolveAttributionShellFamily({ platform: 'win32', isWsl: true })).toBe('posix')
    expect(resolveAttributionShellFamily({ platform: 'darwin', shellPath: '/bin/zsh' })).toBe(
      undefined
    )
  })

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

    const attributionEnv = { PATH: stripInheritedAttributionPath(process.env.PATH ?? '') }
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

    const attributionEnv = { PATH: stripInheritedAttributionPath(process.env.PATH ?? '') }
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

    const attributionEnv = { PATH: stripInheritedAttributionPath(process.env.PATH ?? '') }
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

    const attributionEnv = { PATH: stripInheritedAttributionPath(process.env.PATH ?? '') }
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

    const attributionEnv = { PATH: stripInheritedAttributionPath(process.env.PATH ?? '') }
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
    writeFakeTool(
      binDir,
      'git',
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "commit" ]]; then
  printf '%s\\n' "$@" >"${bashPath(argsPath)}"
  exit 9
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const attributionEnv = { PATH: pathWithToolDir(binDir) }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    expect(() =>
      execToolSync('git', ['commit', '-F', join(root, 'missing-message.txt')], {
        env: attributionEnv
      })
    ).toThrow()

    expect(readFileSync(argsPath, 'utf8')).not.toContain('Co-authored-by: Orca')
  }, 15_000)

  it('passes reuse and fixup commit message modes through without attribution', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const argsPath = join(root, 'commit-args')
    const messagePath = join(root, 'message.txt')
    mkdirSync(binDir)
    writeFileSync(messagePath, 'from file\n')
    writeFakeTool(
      binDir,
      'git',
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "commit" ]]; then
  printf '%s\\n' "$@" >>"${bashPath(argsPath)}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const attributionEnv = { PATH: pathWithToolDir(binDir) }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    execToolSync('git', ['commit', '-C', 'HEAD'], { env: attributionEnv })
    execToolSync('git', ['commit', '--fixup', 'HEAD'], { env: attributionEnv })
    execToolSync('git', ['commit', '-F', messagePath, '--fixup', 'HEAD'], {
      env: attributionEnv
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
if [[ -f "${gitBashPath(hookCounterPath)}" ]]; then
  count="$(cat "${gitBashPath(hookCounterPath)}")"
fi
printf '%s\\n' "$((count + 1))" >"${gitBashPath(hookCounterPath)}"
grep -Fq 'Co-authored-by: Orca <help@stably.ai>' "$1"
`,
      'utf8'
    )
    chmodSync(hookPath, 0o755)
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    runGit(repo, ['add', 'README.md'])

    const attributionEnv = { PATH: stripInheritedAttributionPath(process.env.PATH ?? '') }
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
    writeFakeTool(
      binDir,
      'git',
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2 $3" == "config --bool commit.gpgsign" ]]; then
  printf '%s\\n' 'true'
  exit 0
fi
if [[ "$1" == "commit" ]]; then
  if [[ "\${2:-}" == "--amend" ]]; then
    touch "${bashPath(amendPath)}"
  else
    printf '%s\\n' "$@" >"${bashPath(argsPath)}"
    touch "${bashPath(commitPath)}"
  fi
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const attributionEnv = { PATH: pathWithToolDir(binDir) }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    execToolSync('git', ['commit', '-m', 'signed commit'], { env: attributionEnv })

    expect(existsSync(commitPath)).toBe(true)
    expect(existsSync(amendPath)).toBe(false)
    expect(readFileSync(argsPath, 'utf8')).toContain('Co-authored-by: Orca <help@stably.ai>')
  })

  it('passes editor-based commits through without attribution', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const argsPath = join(root, 'commit-args')
    mkdirSync(binDir)
    writeFakeTool(
      binDir,
      'git',
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "commit" ]]; then
  printf '%s\\n' "$@" >"${bashPath(argsPath)}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const attributionEnv = { PATH: pathWithToolDir(binDir) }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    execToolSync('git', ['commit'], { env: attributionEnv })

    expect(readFileSync(argsPath, 'utf8')).toBe('commit\n')
  })

  it('preserves interactive gh pr create without guessing which PR to edit', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const markerPath = join(root, 'gh-edit-called')
    mkdirSync(binDir)
    writeFakeTool(
      binDir,
      'gh',
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
  touch "${bashPath(markerPath)}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: pathWithToolDir(binDir) }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    const output = execToolSync('gh', ['pr', 'create'], { env: attributionEnv })

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
    writeFakeTool(
      binDir,
      'gh',
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
  printf '%s\\n' "$@" >"${bashPath(patchArgsPath)}"
  touch "${bashPath(prMarkerPath)}"
  exit 0
fi
if [[ "$1 $2 $3 $4" == "api -X PATCH repos/stablyai/orca/issues/456" ]]; then
  touch "${bashPath(issueMarkerPath)}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: pathWithToolDir(binDir) }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    expect(
      normalizeToolOutput(execToolSync('gh', ['pr', 'create', '--fill'], { env: attributionEnv }))
    ).toBe('https://github.com/stablyai/orca/pull/123\n')
    expect(
      normalizeToolOutput(
        execToolSync('gh', ['issue', 'create', '--title', 'Issue', '--body', 'Body'], {
          env: attributionEnv
        })
      )
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
    writeFakeTool(
      binDir,
      'gh',
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
  touch "${bashPath(markerPath)}"
  exit 0
fi
if [[ "$1 $2 $3 $4" == "api -X PATCH repos/stablyai/orca/issues/456" ]]; then
  touch "${bashPath(markerPath)}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: pathWithToolDir(binDir) }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    const output = execToolSync('gh', ['pr', 'create', '--help'], { env: attributionEnv })

    expect(output).toBe('pr help\n')
    const issueOutput = execToolSync('gh', ['issue', 'create', '--help'], {
      env: attributionEnv
    })

    expect(issueOutput).toBe('issue help\n')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('preserves interactive gh issue create without guessing which issue to edit', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const markerPath = join(root, 'gh-edit-called')
    mkdirSync(binDir)
    writeFakeTool(
      binDir,
      'gh',
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
  touch "${bashPath(markerPath)}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: pathWithToolDir(binDir) }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    const output = execToolSync('gh', ['issue', 'create'], { env: attributionEnv })

    expect(output).toBe('interactive issue create complete\n')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('skips gh attribution edits when viewing the created item fails', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    const markerPath = join(root, 'gh-edit-called')
    mkdirSync(binDir)
    writeFakeTool(
      binDir,
      'gh',
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
  touch "${bashPath(markerPath)}"
  exit 0
fi
exit 1
`,
      'utf8'
    )
    chmodSync(join(binDir, 'gh'), 0o755)
    const attributionEnv = { PATH: pathWithToolDir(binDir) }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    const output = execToolSync('gh', ['pr', 'create', '--fill'], { env: attributionEnv })

    expect(normalizeToolOutput(output)).toBe('https://github.com/stablyai/orca/pull/123\n')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('keeps gh create successful when the attribution edit fails', () => {
    const root = makeTmpRoot()
    const binDir = join(root, 'bin')
    mkdirSync(binDir)
    writeFakeTool(
      binDir,
      'gh',
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
    const attributionEnv = { PATH: pathWithToolDir(binDir) }
    applyTerminalAttributionEnv(attributionEnv, {
      enabled: true,
      userDataPath: join(root, 'user-data')
    })

    const output = execToolSync('gh', ['pr', 'create', '--fill'], { env: attributionEnv })

    expect(normalizeToolOutput(output)).toBe('https://github.com/stablyai/orca/pull/123\n')
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
    const baseEnv: Record<string, string> = {
      PATH: stripInheritedAttributionPath(process.env.PATH ?? '')
    }
    const options = { enabled: true, userDataPath: join(root, 'user-data') }
    const pathDelimiter = process.platform === 'win32' ? ';' : ':'

    applyTerminalAttributionEnv(baseEnv, options)
    applyTerminalAttributionEnv(baseEnv, options)

    const shimEntries = baseEnv.PATH.split(pathDelimiter).filter((entry) =>
      entry.includes('orca-terminal-attribution')
    )
    expect(new Set(shimEntries).size).toBe(shimEntries.length)
  })

  it('puts only Windows shims on PATH for native Windows shells', () => {
    const root = makeTmpRoot()
    const userDataPath = join(root, 'user-data')
    const baseEnv: Record<string, string> = { PATH: 'C:\\Git\\cmd;C:\\Windows\\System32' }

    applyTerminalAttributionEnv(baseEnv, {
      enabled: true,
      platform: 'win32',
      shellFamily: 'native-windows',
      userDataPath
    })

    const posixDir = join(userDataPath, 'orca-terminal-attribution', 'posix')
    const win32Dir = join(userDataPath, 'orca-terminal-attribution', 'win32')
    const pathEntries = baseEnv.PATH.split(';')

    expect(pathEntries[0]).toBe(win32Dir)
    expect(pathEntries).not.toContain(posixDir)
    expect(baseEnv.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
    expect(existsSync(join(win32Dir, 'git.cmd'))).toBe(true)
  })

  it('keeps POSIX shims first for Windows Git Bash and WSL shells', () => {
    const root = makeTmpRoot()
    const userDataPath = join(root, 'user-data')
    const baseEnv: Record<string, string> = { PATH: 'C:\\Program Files\\Git\\cmd;C:\\Windows' }

    applyTerminalAttributionEnv(baseEnv, {
      enabled: true,
      platform: 'win32',
      shellFamily: 'posix',
      userDataPath
    })

    const posixDir = join(userDataPath, 'orca-terminal-attribution', 'posix')
    const win32Dir = join(userDataPath, 'orca-terminal-attribution', 'win32')
    const pathEntries = baseEnv.PATH.split(';')

    expect(pathEntries[0]).toBe(posixDir)
    expect(pathEntries).not.toContain(win32Dir)
    expect(baseEnv.ORCA_ATTRIBUTION_SHIM_DIR).toBe(posixDir)
    expect(existsSync(join(posixDir, 'git'))).toBe(true)
  })

  it('writes PowerShell wrappers without raw-template backslash escapes', () => {
    const root = makeTmpRoot()
    applyTerminalAttributionEnv(
      { PATH: stripInheritedAttributionPath(process.env.PATH ?? '') },
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
