import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SshTarget } from '../../shared/ssh-types'
import { expandSshConfigIncludes } from './ssh-config-include-expander'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'
export { parseSshGOutput, resolveWithSshG, type SshResolvedConfig } from './ssh-g-config-resolution'

export type SshConfigHost = {
  host: string
  hostname?: string
  port?: number
  user?: string
  identityFile?: string
  identityAgent?: string
  identitiesOnly?: boolean
  proxyCommand?: string
  proxyUseFdpass?: boolean
  proxyJump?: string
}

/**
 * Parse an OpenSSH config file into structured host entries.
 * Handles Host blocks with single or multiple patterns.
 * Ignores wildcard-only patterns (e.g. "Host *").
 */
export function parseSshConfig(content: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  let current: SshConfigHost[] = []

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const directive = parseConfigDirective(line)
    if (!directive) {
      continue
    }

    const { key, rawValue } = directive

    if (key === 'host') {
      if (current.length > 0) {
        appendHosts(hosts, current)
      }

      const patterns = splitHostPatterns(rawValue)
      const concretePatterns = patterns.filter(
        (pattern) => !pattern.startsWith('!') && !pattern.includes('*') && !pattern.includes('?')
      )
      if (concretePatterns.length === 0) {
        current = []
        continue
      }

      current = concretePatterns.map((pattern) => ({ host: pattern }))
      continue
    }

    if (key === 'match') {
      if (current.length > 0) {
        appendHosts(hosts, current)
      }
      current = []
      continue
    }

    if (current.length === 0) {
      continue
    }

    const value = parseScalarConfigValue(rawValue)

    switch (key) {
      case 'hostname':
        for (const host of current) {
          host.hostname = value
        }
        break
      case 'port':
        for (const host of current) {
          host.port = Number.parseInt(value, 10) || 22
        }
        break
      case 'user':
        for (const host of current) {
          host.user = value
        }
        break
      case 'identityfile':
        for (const host of current) {
          host.identityFile = resolveSshConfigHomePath(value)
        }
        break
      case 'identityagent':
        for (const host of current) {
          host.identityAgent = resolveSshConfigHomePath(value)
        }
        break
      case 'identitiesonly':
        for (const host of current) {
          host.identitiesOnly = value.toLowerCase() === 'yes'
        }
        break
      case 'proxycommand':
        for (const host of current) {
          // Why: OpenSSH treats ProxyCommand as a shell snippet and preserves
          // the rest of the line, including quotes and `#` characters.
          host.proxyCommand = rawValue.trim()
        }
        break
      case 'proxyusefdpass':
        for (const host of current) {
          host.proxyUseFdpass = value.toLowerCase() === 'yes'
        }
        break
      case 'proxyjump':
        for (const host of current) {
          host.proxyJump = value
        }
        break
    }
  }

  if (current.length > 0) {
    appendHosts(hosts, current)
  }
  return hosts
}

function appendHosts(target: SshConfigHost[], entries: SshConfigHost[]): void {
  // Why: generated SSH configs can put many concrete aliases on one Host line;
  // spreading that block into push can exceed JavaScript's argument limit.
  for (const entry of entries) {
    target.push(entry)
  }
}

function parseConfigDirective(line: string): { key: string; rawValue: string } | null {
  const match = line.match(/^([^=\s]+)(?:\s*=\s*|\s+)(.*)$/)
  if (!match) {
    return null
  }

  return {
    key: match[1].toLowerCase(),
    rawValue: match[2].trim()
  }
}

function parseScalarConfigValue(input: string): string {
  // Why: scalar OpenSSH directives strip wrapping quotes and inline comments;
  // keeping them would turn valid config values into bad hostnames/users/paths.
  return splitOpenSshArguments(input)[0] ?? ''
}

function splitHostPatterns(input: string): string[] {
  return splitOpenSshArguments(input)
}

function splitOpenSshArguments(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuotes = false
  let escaped = false

  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (inQuotes && char === '\\') {
      escaped = true
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }

    // Why: multi-alias import must not turn OpenSSH inline comments into targets.
    if (!inQuotes && char === '#') {
      break
    }

    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    args.push(current)
  }

  return args
}

/** Read and parse the user's ~/.ssh/config file. Returns empty array if not found. */
export function loadUserSshConfig(): SshConfigHost[] {
  const configPath = join(homedir(), '.ssh', 'config')
  if (!existsSync(configPath)) {
    return []
  }

  try {
    const content = expandSshConfigIncludes(configPath)
    return parseSshConfig(content)
  } catch {
    console.warn(`[ssh] Failed to read SSH config at ${configPath}`)
    return []
  }
}

/** Convert parsed SSH config hosts into SshTarget objects for import. */
export function sshConfigHostsToTargets(
  hosts: SshConfigHost[],
  existingTargetHosts: Set<string>
): SshTarget[] {
  const targets: SshTarget[] = []
  const seenLabels = new Set(existingTargetHosts)

  for (const entry of hosts) {
    const effectiveHost = entry.hostname || entry.host
    const label = entry.host

    if (seenLabels.has(label)) {
      continue
    }
    seenLabels.add(label)

    targets.push({
      id: `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label,
      configHost: entry.host,
      host: effectiveHost,
      port: entry.port ?? 22,
      username: entry.user ?? '',
      identityFile: entry.identityFile,
      identityAgent: entry.identityAgent,
      identitiesOnly: entry.identitiesOnly,
      proxyCommand: entry.proxyCommand,
      jumpHost: entry.proxyJump
    })
  }

  return targets
}
