import {
  isShebangLine,
  parseSetupScriptShebang,
  stripLeadingShebangLine
} from '../shared/setup-script-shebang'

// Why: cmd cannot run a POSIX script, and executing its interpreter-agnostic prefix (`pnpm
// install`, `git submodule update`) before dying on the first bash-only line is worse than not
// starting: half-applied setup looks like a working worktree.
const WINDOWS_RUNNER_SHEBANG_REFUSAL = [
  'echo Orca setup: this script starts with a "#!" interpreter line, so it needs a POSIX shell. 1>&2',
  'echo Orca setup: this worktree runs setup through cmd.exe, which cannot execute it. 1>&2',
  'echo Orca setup: set the Windows terminal shell to Git Bash, or rewrite the script in cmd syntax. 1>&2',
  'exit /b 1',
  ''
].join('\r\n')

export function buildWindowsRunnerScript(script: string): string {
  // Why: launchers invoke this runner under `cmd /v:on`, and EnableExtensions does not reset an
  // inherited delayed-expansion state — without this, every `!` in a user setup line is eaten.
  const header = '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n'
  let runnerScript = header
  let isFirstLine = true

  for (const rawLine of iterateLfScriptLines(script)) {
    const command = rawLine.trim()
    if (isFirstLine) {
      isFirstLine = false
      if (isShebangLine(command)) {
        return `${header}${WINDOWS_RUNNER_SHEBANG_REFUSAL}`
      }
    }
    if (!command) {
      runnerScript += '\r\n'
      continue
    }

    // Why: npm/pnpm are Windows batch files; `call` each line and bail on errorlevel for set -e fail-fast behavior.
    runnerScript += `call ${command}\r\nif errorlevel 1 exit /b %errorlevel%\r\n`
  }

  return runnerScript
}

export function* iterateLfScriptLines(script: string): Generator<string> {
  let lineStart = 0

  for (let index = 0; index < script.length; index++) {
    if (script.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && script.charCodeAt(index - 1) === 13 ? index - 1 : index
    yield script.slice(lineStart, lineEnd)
    lineStart = index + 1
  }

  if (lineStart <= script.length) {
    yield script.slice(lineStart)
  }
}

export function buildPosixRunnerScript(script: string): string {
  // Why: the runner is always launched as `bash <path>`, so flags on the script's own `#!` line
  // are never seen by the interpreter — replay them through `set` or a script that asked for
  // `-euo pipefail` silently loses pipefail, and drop the now-duplicate interpreter line.
  const shebang = parseSetupScriptShebang(script)
  const declaredOptions = shebang?.shellOptions.length
    ? `set ${shebang.shellOptions.join(' ')}\n`
    : ''
  const body = shebang ? stripLeadingShebangLine(script) : script
  return `#!/usr/bin/env bash\nset -e\n${declaredOptions}${normalizeCrlfScriptLineEndings(body)}\n`
}

function normalizeCrlfScriptLineEndings(script: string): string {
  let crlfStart = script.indexOf('\r\n')
  if (crlfStart === -1) {
    return script
  }

  let normalized = script.slice(0, crlfStart)
  let chunkStart = crlfStart + 2
  normalized += '\n'
  crlfStart = script.indexOf('\r\n', chunkStart)

  while (crlfStart !== -1) {
    normalized += script.slice(chunkStart, crlfStart)
    normalized += '\n'
    chunkStart = crlfStart + 2
    crlfStart = script.indexOf('\r\n', chunkStart)
  }

  return `${normalized}${script.slice(chunkStart)}`
}
