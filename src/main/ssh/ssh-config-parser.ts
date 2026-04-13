import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { SshTarget } from '../../shared/ssh-types'

export type SshConfigHost = {
  host: string
  hostname?: string
  port?: number
  user?: string
  identityFile?: string
  proxyCommand?: string
  proxyJump?: string
}

/**
 * Parse an OpenSSH config file into structured host entries.
 * Handles Host blocks with single or multiple patterns.
 * Ignores wildcard-only patterns (e.g. "Host *").
 */
export function parseSshConfig(content: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  let current: SshConfigHost | null = null

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
      if (current) {
        hosts.push(current)
      }

      // Skip wildcard-only entries (e.g. "Host *" or "Host *.*")
      const patterns = value.split(/\s+/)
      const hasConcretePattern = patterns.some((p) => !p.includes('*') && !p.includes('?'))
      if (!hasConcretePattern) {
        current = null
        continue
      }

      current = { host: patterns[0] }
      continue
    }

    if (key === 'match') {
      // Match blocks are complex conditionals — push current and skip
      if (current) {
        hosts.push(current)
      }
      current = null
      continue
    }

    if (!current) {
      continue
    }

    switch (key) {
      case 'hostname':
        current.hostname = value
        break
      case 'port':
        current.port = parseInt(value, 10) || 22
        break
      case 'user':
        current.user = value
        break
      case 'identityfile':
        current.identityFile = resolveHomePath(value)
        break
      case 'proxycommand':
        current.proxyCommand = value
        break
      case 'proxyjump':
        current.proxyJump = value
        break
    }
  }

  if (current) {
    hosts.push(current)
  }
  return hosts
}

function resolveHomePath(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return join(homedir(), filepath.slice(1))
  }
  return filepath
}

/** Read and parse the user's ~/.ssh/config file. Returns empty array if not found. */
export function loadUserSshConfig(): SshConfigHost[] {
  const configPath = join(homedir(), '.ssh', 'config')
  if (!existsSync(configPath)) {
    return []
  }

  try {
    const content = readFileSync(configPath, 'utf-8')
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

  for (const entry of hosts) {
    const effectiveHost = entry.hostname || entry.host
    const label = entry.host

    // Skip if already imported (match on label, which is the Host alias)
    if (existingTargetHosts.has(label)) {
      continue
    }

    targets.push({
      id: `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label,
      host: effectiveHost,
      port: entry.port ?? 22,
      username: entry.user ?? '',
      identityFile: entry.identityFile,
      proxyCommand: entry.proxyCommand,
      jumpHost: entry.proxyJump
    })
  }

  return targets
}
