import type { CommitMessagePlan } from '../../../../shared/source-control/ai/generation/commit-message-plan'
import { buildPosixStdoutFence } from '../../../../shared/shell/launch/posix-stdout-fence'
import {
  getPowerShellEscapeNativeArgsFunction,
  quotePowerShellLiteral
} from '../../../../shared/shell/launch/powershell-native-argument'
import { quotePosixShell } from '../../../../shared/shell/launch/shell-argument-quoting'
import { powerShellCommand } from '../../../ssh/remote-exec/ssh-remote-powershell'

// Login shells that accept `sh -lc`. fish, csh, tcsh, and nu do not.
const POSIX_LOGIN_SHELLS = 'sh|dash|bash|zsh|ksh|mksh|ash'

function envNameIsPassable(key: string): boolean {
  // A leading `-` is an option to POSIX `env` (`-u=foo` is `unsetenv`), including after `--` on some
  // implementations. Rejecting it is portable across GNU, BSD, and BusyBox `env`.
  return (
    key.length > 0 &&
    !key.startsWith('-') &&
    !key.includes('=') &&
    !key.includes('\0') &&
    !/[\r\n]/.test(key)
  )
}

function envValueIsPassable(value: string): boolean {
  // Newlines are legal inside single quotes. NUL would truncate the assignment.
  return !value.includes('\0')
}

/**
 * One single-quoted `KEY=VALUE` argument to `env`. POSIX `env` accepts names that are not
 * shell identifiers (`orca.review`) and the quotes block every metacharacter in the name or value.
 */
export function posixProbeEnvPrefix(env: Record<string, string> | undefined): string {
  const args: string[] = []
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!envNameIsPassable(key) || !envValueIsPassable(value)) {
      continue
    }
    args.push(quotePosixShell(`${key}=${value}`))
  }
  return args.length > 0 ? `env ${args.join(' ')}` : ''
}

/**
 * Process-scoped .NET assignment. The name is a quoted string, never `$env:<raw>`.
 * Win32 `SetEnvironmentVariableW(name, "")` deletes the variable, and Windows PowerShell 5.1
 * does the same for `''`, so an explicit empty override clears the variable with `$null`.
 */
export function powershellProbeEnvStatements(env: Record<string, string> | undefined): string[] {
  const statements: string[] = []
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!envNameIsPassable(key) || value.includes('\0')) {
      continue
    }
    const literal = value === '' ? '$null' : quotePowerShellLiteral(value)
    statements.push(
      `[System.Environment]::SetEnvironmentVariable(${quotePowerShellLiteral(key)}, ${literal}, 'Process')`
    )
  }
  return statements
}

export type PosixModelProbeCommand = {
  command: string
  /** Probe stdout inside the login-shell fence. Unfenced text is returned unchanged. */
  readStdout: (stdout: string) => string
  endMarker: string
}

export function buildPosixModelProbeCommand(
  cwd: string,
  plan: CommitMessagePlan
): PosixModelProbeCommand {
  const argv = [plan.binary, ...plan.args].map((part) => quotePosixShell(part)).join(' ')
  const prefix = posixProbeEnvPrefix(plan.env)
  const inner = `cd ${quotePosixShell(cwd)} && ${prefix ? `${prefix} ` : ''}${argv}`
  // Why inside the login -lc script: profile banners print before it and .bash_logout/.zlogout
  // after it. Why no exec: execCommandOnce fences this command, and exec would skip that end marker.
  const fence = buildPosixStdoutFence(inner, 'SSH_PROBE')
  const quoted = quotePosixShell(fence.command)
  const command = [
    'case "${SHELL##*/}" in',
    `  ${POSIX_LOGIN_SHELLS}) "$SHELL" -lc ${quoted} ;;`,
    `  *) /bin/sh -lc ${quoted} ;;`,
    'esac'
  ].join('\n')
  return {
    command,
    endMarker: fence.endMarker,
    readStdout: (stdout) => fence.readStdout(stdout) ?? stdout
  }
}

export function buildWindowsModelProbeCommand(cwd: string, plan: CommitMessagePlan): string {
  const args =
    plan.args.length === 0
      ? '@()'
      : `@(${plan.args.map((arg) => quotePowerShellLiteral(arg)).join(', ')})`
  // Why two lookup paths: npm's cmd-shim writes an extensionless Bourne script beside .cmd and .ps1.
  // For a rooted/relative path, Test-Path -LiteralPath prefers .exe/.cmd/.bat/.com without wildcard
  // expansion (preserving paths containing [ or ]) and avoids selecting the extensionless shell
  // script or .ps1 shim. For a bare name, Get-Command -CommandType Application skips .ps1 shims.
  // Why capture $?: Invoke-Expression resets $? to $true and if ($null -ne $LASTEXITCODE) clobbers
  // $? before a missing-binary fallback check, so capturing $? right after & preserves exit 1.
  return powerShellCommand(
    [
      getPowerShellEscapeNativeArgsFunction(),
      ...powershellProbeEnvStatements(plan.env),
      `Set-Location -ErrorAction Stop -LiteralPath ${quotePowerShellLiteral(cwd)}`,
      `$OrcaProbeProgram = ${quotePowerShellLiteral(plan.binary)}`,
      "if ($OrcaProbeProgram -match '[\\\\/]') {",
      "  if ($OrcaProbeProgram -notmatch '\\.(exe|cmd|bat|com|ps1)$') {",
      "    foreach ($OrcaProbeExt in @('.exe', '.cmd', '.bat', '.com')) {",
      '      $OrcaProbeCandidate = "$OrcaProbeProgram$OrcaProbeExt"',
      '      if (Test-Path -LiteralPath $OrcaProbeCandidate -PathType Leaf) {',
      '        $OrcaProbeProgram = $OrcaProbeCandidate',
      '        break',
      '      }',
      '    }',
      '  }',
      '} else {',
      '  $OrcaProbeCommand = Get-Command -Name $OrcaProbeProgram -CommandType Application -ErrorAction SilentlyContinue |',
      '    Select-Object -First 1',
      '  if ($null -ne $OrcaProbeCommand) { $OrcaProbeProgram = $OrcaProbeCommand.Source }',
      '}',
      `$OrcaProbeArgs = ${args}`,
      '$OrcaProbeEscaped = @(__OrcaEscapeNativeArgs $OrcaProbeProgram $OrcaProbeArgs)',
      '$global:LASTEXITCODE = $null',
      '& $OrcaProbeProgram @OrcaProbeEscaped',
      '$OrcaProbeOk = $?',
      'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
      'if (-not $OrcaProbeOk) { exit 1 }'
    ].join('\n')
  )
}
