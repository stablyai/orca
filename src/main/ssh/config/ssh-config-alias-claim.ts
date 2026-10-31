import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeSshConfigAlias } from '../../../shared/ssh-config-alias'
import { expandSshConfigIncludes } from './ssh-config-include-expander'
import { parseSshConfigAliasClaims, type SshConfigAliasClaims } from './ssh-config-parser'

/** False alone proves the alias is unclaimed and permits override; unreadable config, Match blocks, negations and possible matches must return true. */
export function sshConfigMayClaimAlias(
  alias: string,
  claims: SshConfigAliasClaims | null
): boolean {
  const normalizedAlias = normalizeSshConfigAlias(alias)
  if (!normalizedAlias || claims === null) {
    return true
  }
  // Unmodeled Match criteria may route this alias; retain uncertainty.
  if (claims.hasMatchBlock) {
    return true
  }
  return claims.hostPatternGroups.some((patterns) =>
    // Negated groups may still route other aliases; never call the whole group unclaimed.
    patterns.some((pattern) => pattern.startsWith('!'))
      ? true
      : patterns.some(
          (pattern) =>
            !isCatchAllHostPattern(pattern) && matchesHostPattern(pattern, normalizedAlias)
        )
  )
}

/** Bare catch-alls prove no alias-specific claim. */
function isCatchAllHostPattern(pattern: string): boolean {
  return pattern.length > 0 && /^\*+$/.test(pattern)
}

function matchesHostPattern(pattern: string, normalizedAlias: string): boolean {
  let expression = ''
  for (const character of normalizeSshConfigAlias(pattern)) {
    if (character === '*') {
      expression += '.*'
    } else if (character === '?') {
      expression += '.'
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/, '\\$&')
    }
  }
  return new RegExp(`^${expression}$`).test(normalizedAlias)
}

// Bound staleness of Includes without re-expanding them for every remote command.
const CLAIM_CACHE_TTL_MS = 5_000

let cachedClaims: { key: string; readAt: number; claims: SshConfigAliasClaims } | null = null

/** Null means unreadable/absent, not proof of an empty config. */
function loadUserSshConfigAliasClaims(): SshConfigAliasClaims | null {
  const configPath = join(homedir(), '.ssh', 'config')
  try {
    if (!existsSync(configPath)) {
      return null
    }
    // Root metadata alone misses Include edits, so also expire by TTL.
    const stats = statSync(configPath)
    const key = `${stats.mtimeMs}:${stats.size}`
    const now = Date.now()
    if (cachedClaims?.key === key && now - cachedClaims.readAt < CLAIM_CACHE_TTL_MS) {
      return cachedClaims.claims
    }
    const claims = parseSshConfigAliasClaims(expandSshConfigIncludes(configPath))
    cachedClaims = { key, readAt: now, claims }
    return claims
  } catch {
    return null
  }
}

export function mayUserSshConfigClaimAlias(alias: string): boolean {
  return sshConfigMayClaimAlias(alias, loadUserSshConfigAliasClaims())
}
