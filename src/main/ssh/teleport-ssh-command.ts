import type { SshTarget } from '../../shared/ssh-types'
import type { SystemSshResolvedConfig } from './ssh-control-socket'
import { isOpenSshConfigBackedTarget } from './system-ssh-args'

export type TeleportSshCommand = {
  executable: string
  args: string[]
  targetIndex: number
}

const UNSAFE_UNQUOTED_SHELL_CHARACTERS = new Set('|&;<>(){}*?[]#\r\n')

// Why: `tsh ssh` is a complete SSH client, not a raw ProxyCommand byte stream;
// nesting it under OpenSSH makes the two SSH protocol engines corrupt each other.
export function buildTeleportSshCommand(
  target: SshTarget,
  resolvedConfig?: SystemSshResolvedConfig | null,
  remoteCommand?: string
): TeleportSshCommand | null {
  const proxyCommand = resolveEffectiveProxyCommand(target, resolvedConfig)
  const parsed = proxyCommand ? parseTeleportSshProxyCommand(proxyCommand) : null
  if (!parsed) {
    return null
  }

  const endpoint = resolveEffectiveEndpoint(target, resolvedConfig)
  const args = parsed.args.map((arg) => expandOpenSshTokens(arg, endpoint))
  let targetIndex = parsed.targetIndex
  if (endpoint.port !== 22 && !hasExplicitPort(args, parsed.sshIndex, targetIndex)) {
    args.splice(targetIndex, 0, '-p', String(endpoint.port))
    targetIndex += 2
  }
  if (remoteCommand !== undefined) {
    args.push(remoteCommand)
  }

  return { executable: parsed.executable, args, targetIndex }
}

export function buildTeleportSshPortForwardCommand(
  target: SshTarget,
  localPort: number,
  remoteHost: string,
  remotePort: number,
  resolvedConfig?: SystemSshResolvedConfig | null
): TeleportSshCommand | null {
  const command = buildTeleportSshCommand(target, resolvedConfig)
  if (!command) {
    return null
  }

  const args = [...command.args]
  args.splice(command.targetIndex, 0, '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`)
  return { ...command, args, targetIndex: command.targetIndex + 2 }
}

type ParsedTeleportProxyCommand = {
  executable: string
  args: string[]
  sshIndex: number
  targetIndex: number
}

function parseTeleportSshProxyCommand(command: string): ParsedTeleportProxyCommand | null {
  const words = splitLiteralCommandWords(command)
  if (!words || words.length < 3 || !isTshExecutable(words[0])) {
    return null
  }

  const sshWordIndex = words.indexOf('ssh', 1)
  if (sshWordIndex === -1 || words.slice(1, sshWordIndex).includes('proxy')) {
    return null
  }
  const targetWordIndex = words.length - 1
  // Why: a ProxyCommand containing a remote command or shell expression has
  // ambiguous tsh semantics; leave it on OpenSSH's existing shell-backed path.
  if (targetWordIndex <= sshWordIndex || !words[targetWordIndex].includes('%h')) {
    return null
  }

  return {
    executable: words[0],
    args: words.slice(1),
    sshIndex: sshWordIndex - 1,
    targetIndex: targetWordIndex - 1
  }
}

function isTshExecutable(executable: string): boolean {
  if (executable.startsWith('~') || /[$`%]/.test(executable)) {
    return false
  }
  const normalized = executable.replaceAll('\\', '/')
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  return basename === 'tsh' || basename === 'tsh.exe'
}

function resolveEffectiveProxyCommand(
  target: SshTarget,
  resolvedConfig: SystemSshResolvedConfig | null | undefined
): string | undefined {
  if (isOpenSshConfigBackedTarget(target)) {
    return resolvedConfig?.proxyCommand ?? target.proxyCommand
  }
  return target.proxyCommand ?? resolvedConfig?.proxyCommand
}

type TeleportEndpoint = { host: string; port: number; user: string }

function resolveEffectiveEndpoint(
  target: SshTarget,
  resolvedConfig: SystemSshResolvedConfig | null | undefined
): TeleportEndpoint {
  const configBacked = isOpenSshConfigBackedTarget(target)
  return {
    host: configBacked
      ? resolvedConfig?.hostname || target.host || target.configHost || target.label
      : target.host || resolvedConfig?.hostname || target.configHost || target.label,
    port: configBacked
      ? resolvedConfig?.port || target.port || 22
      : target.port || resolvedConfig?.port || 22,
    user: target.username || resolvedConfig?.user || ''
  }
}

function expandOpenSshTokens(value: string, endpoint: TeleportEndpoint): string {
  return value.replace(/%%|%[hpr]/g, (token) => {
    switch (token) {
      case '%%':
        return '%'
      case '%h':
        return endpoint.host
      case '%p':
        return String(endpoint.port)
      case '%r':
        return endpoint.user
      default:
        return token
    }
  })
}

function hasExplicitPort(args: string[], sshIndex: number, targetIndex: number): boolean {
  return args
    .slice(sshIndex + 1, targetIndex)
    .some((arg) => arg === '-p' || arg === '--port' || arg.startsWith('--port='))
}

function splitLiteralCommandWords(command: string): string[] | null {
  const words: string[] = []
  let current = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      const next = command[index + 1]
      if (next && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
        escaped = true
        inWord = true
        continue
      }
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char
      inWord = true
      continue
    }
    if (quote === char) {
      quote = null
      continue
    }
    if (quote !== "'" && /[$`]/.test(char)) {
      return null
    }
    if (quote === null && UNSAFE_UNQUOTED_SHELL_CHARACTERS.has(char)) {
      return null
    }
    if (quote === null && /\s/.test(char)) {
      if (inWord) {
        words.push(current)
        current = ''
        inWord = false
      }
      continue
    }
    current += char
    inWord = true
  }

  if (escaped || quote !== null) {
    return null
  }
  if (inWord) {
    words.push(current)
  }
  if (words.some((word) => word.startsWith('~'))) {
    return null
  }
  return words
}
