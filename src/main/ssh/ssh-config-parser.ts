import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import type { SshTarget } from '../../shared/ssh-types'
import { expandSshConfigIncludes } from './ssh-config-include-expander'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'

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

    const match = line.match(/^(\S+)\s+(.+)$/)
    if (!match) {
      continue
    }

    const [, keyword, rawValue] = match
    const key = keyword.toLowerCase()
    const value = rawValue.trim()

    if (key === 'host') {
      if (current.length > 0) {
        appendHosts(hosts, current)
      }

      const patterns = splitHostPatterns(value)
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

    switch (key) {
      case 'hostname':
        for (const host of current) {
          host.hostname = value
        }
        break
      case 'port':
        for (const host of current) {
          host.port = parseInt(value, 10) || 22
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
          host.proxyCommand = value
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

function splitHostPatterns(input: string): string[] {
  const patterns: string[] = []
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
        patterns.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    patterns.push(current)
  }

  return patterns
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
// ── ssh -G config resolution ──────────────────────────────────────────

export type SshResolvedConfig = {
  hostname: string
  user?: string
  port: number
  identityFile: string[]
  identityAgent?: string
  identitiesOnly: boolean
  forwardAgent: boolean
  proxyCommand?: string
  proxyUseFdpass: boolean
  proxyJump?: string
}

const SSH_G_TIMEOUT_MS = 5000

// Why: `ssh -G <host>` asks OpenSSH to resolve the full effective config
// for a host, including Include directives, Match blocks, wildcard
// inheritance, and ProxyCommand expansion. This gives us correct config
// resolution without reimplementing OpenSSH's complex matching logic.
export function resolveWithSshG(host: string): Promise<SshResolvedConfig | null> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof execFile> | undefined
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child?.kill()
      resolve(null)
    }, SSH_G_TIMEOUT_MS)

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      callback()
    }

    // Why: '--' prevents a host label starting with '-' from being interpreted
    // as an SSH flag (classic argument injection vector).
    // Why: execFile's timeout only signals ssh; a stuck callback must still
    // release SSH import/connection resolution with the existing null fallback.
    try {
      child = execFile('ssh', ['-G', '--', host], { timeout: SSH_G_TIMEOUT_MS }, (err, stdout) => {
        if (err) {
          settle(() => resolve(null))
          return
        }
        settle(() => resolve(parseSshGOutput(stdout)))
      })
    } catch {
      settle(() => resolve(null))
    }
  })
}

export function parseSshGOutput(stdout: string): SshResolvedConfig {
  const map = new Map<string, string>()
  const identityFiles: string[] = []

  for (const line of stdout.split('\n')) {
    const spaceIdx = line.indexOf(' ')
    if (spaceIdx === -1) {
      continue
    }
    const key = line.substring(0, spaceIdx).toLowerCase()
    const value = line.substring(spaceIdx + 1).trim()
    if (key === 'identityfile') {
      identityFiles.push(resolveSshConfigHomePath(value))
    } else {
      map.set(key, value)
    }
  }

  // Why: `ssh -G` outputs `proxycommand none` / `proxyjump none` when no
  // proxy is configured. Treating "none" as real would spawn bad commands.
  const rawProxy = map.get('proxycommand')
  const proxyCommand = rawProxy && rawProxy !== 'none' ? rawProxy : undefined
  const rawJump = map.get('proxyjump')
  const proxyJump = rawJump && rawJump !== 'none' ? rawJump : undefined
  const rawIdentityAgent = map.get('identityagent')
  const identityAgent = rawIdentityAgent ? resolveSshConfigHomePath(rawIdentityAgent) : undefined

  return {
    hostname: map.get('hostname') ?? '',
    user: map.get('user') || undefined,
    port: parseInt(map.get('port') ?? '22', 10),
    identityFile: identityFiles,
    identityAgent,
    identitiesOnly: map.get('identitiesonly') === 'yes',
    forwardAgent: map.get('forwardagent') === 'yes',
    proxyCommand,
    proxyUseFdpass: map.get('proxyusefdpass') === 'yes',
    proxyJump
  }
}
