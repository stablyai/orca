import { addWslEnvKeys } from '../../wsl-env'
import { quotePosixShell } from '../../../shared/wsl-login-shell-command'
import { execFileCapture } from './exec-file-capture'
import { resolveGitCommand } from './git-command-resolution'
import { DEFAULT_GIT_MAX_BUFFER, type GitExecOptions } from './git-exec-options'
import { promptGuardGitEnv } from './git-process-env'
import { acquireGitAdmission } from './git-subprocess-admission'

export type GitSshPolicyMode =
  | 'default'
  | 'explicit-env'
  | 'fallback'
  | 'configured-openssh'
  | 'configured-wrapper-passthrough'

const CORE_SSH_COMMAND_PROBE_TIMEOUT_MS = 2500

function commandBasename(command: string): string {
  const pieces = command.split(/[\\/]+/)
  return pieces.at(-1)?.toLowerCase() ?? command.toLowerCase()
}

function isMergeableOpenSshCommand(command: string): boolean {
  const basename = commandBasename(command)
  return basename === 'ssh' || basename === 'ssh.exe'
}

function shellTokenize(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      const next = command[i + 1]
      if (next && /[\s'"\\]/.test(next)) {
        escaped = true
      } else {
        current += char
      }
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    if (';&|<>()`'.includes(char)) {
      return null
    }
    current += char
  }

  if (escaped || quote) {
    return null
  }
  if (current) {
    tokens.push(current)
  }
  return tokens
}

function shellQuoteToken(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(token) ? token : quotePosixShell(token)
}

function containsShellExpansionSyntax(command: string): boolean {
  return command.includes('$')
}

function withoutBatchModeOptions(tokens: string[]): string[] {
  const next: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const lower = token.toLowerCase()
    if (lower === '-o') {
      const option = tokens[i + 1]?.toLowerCase()
      if (option?.startsWith('batchmode')) {
        i += 1
        continue
      }
    }
    if (lower.startsWith('-obatchmode')) {
      continue
    }
    next.push(token)
  }
  return next
}

function buildOpenSshBatchModeCommand(configuredCommand: string): string | null {
  if (containsShellExpansionSyntax(configuredCommand)) {
    return null
  }
  const tokens = shellTokenize(configuredCommand)
  if (!tokens || tokens.length === 0 || !isMergeableOpenSshCommand(tokens[0])) {
    return null
  }
  return [...withoutBatchModeOptions(tokens), '-o', 'BatchMode=yes'].map(shellQuoteToken).join(' ')
}

export async function buildNetworkSshPolicyEnv(options: GitExecOptions): Promise<{
  env: NodeJS.ProcessEnv
  mode: GitSshPolicyMode
}> {
  const promptEnv = promptGuardGitEnv(options.env)
  if (promptEnv.GIT_SSH_COMMAND) {
    return { env: promptEnv, mode: 'explicit-env' }
  }

  // Why fenced: a login-shell banner here reads as a user-configured sshCommand,
  // which skips the BatchMode fallback below and disarms the no-prompt guard.
  const resolved = resolveGitCommand(['config', '--get', 'core.sshCommand'], options, true, true)
  const probeArgs = ['config', '--get', 'core.sshCommand']
  const grant = await acquireGitAdmission({
    args: probeArgs,
    cwd: options.cwd,
    wslDistro: options.wslDistro,
    tier: options.admissionTier,
    signal: options.signal
  })
  let reportTerminated: () => void = () => {}
  const terminated = new Promise<void>((resolve) => {
    reportTerminated = resolve
  })
  let configuredCommand = ''
  try {
    const { stdout } = await execFileCapture(resolved.binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: 'utf-8',
      maxBuffer: DEFAULT_GIT_MAX_BUFFER,
      timeout: CORE_SSH_COMMAND_PROBE_TIMEOUT_MS,
      env: promptEnv,
      signal: options.signal,
      onChildTerminated: reportTerminated
    })
    const payload = resolved.captured?.readStdout(String(stdout)) ?? String(stdout)
    configuredCommand = payload.trim()
  } catch {
    configuredCommand = ''
  } finally {
    void terminated.then(grant.release)
  }

  if (!configuredCommand) {
    const env = { ...promptEnv, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
    // Why: WSL routing can come from either an explicit distro or a UNC cwd.
    if (resolved.wsl) {
      addWslEnvKeys(env, ['GIT_SSH_COMMAND'])
    }
    return { env, mode: 'fallback' }
  }

  const batchModeCommand = buildOpenSshBatchModeCommand(configuredCommand)
  if (!batchModeCommand) {
    // Why: custom SSH wrappers are user policy; rewriting their argv is riskier than relying on prompt guards + timeout.
    return { env: promptEnv, mode: 'configured-wrapper-passthrough' }
  }

  const env = { ...promptEnv, GIT_SSH_COMMAND: batchModeCommand }
  if (resolved.wsl) {
    addWslEnvKeys(env, ['GIT_SSH_COMMAND'])
  }
  return { env, mode: 'configured-openssh' }
}
