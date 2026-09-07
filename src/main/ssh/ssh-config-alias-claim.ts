import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeSshConfigAlias } from '../../shared/ssh-config-alias'
import { expandSshConfigIncludes } from './ssh-config-include-expander'
import { parseSshConfigAliasClaims, type SshConfigAliasClaims } from './ssh-config-parser'

/**
 * Whether anything in the user's ssh_config could claim this alias — i.e. whether a `Host` or
 * `Match` block other than a bare catch-all applies to it.
 *
 * Sound in the negative direction only. `false` means the parsed config proves nothing claims the
 * alias; every uncertainty (unreadable file, any `Match` block, any negated `Host` group, any
 * pattern that might match)
 * answers `true`, because "we could not tell" must never be read as "no block exists". Callers use
 * `false` as licence to override what OpenSSH would resolve, so a wrong `false` breaks a config the
 * user explicitly wrote, which is worse than the routing bug it exists to fix.
 */
export function sshConfigMayClaimAlias(
  alias: string,
  claims: SshConfigAliasClaims | null
): boolean {
  const normalizedAlias = normalizeSshConfigAlias(alias)
  if (!normalizedAlias || claims === null) {
    return true
  }
  // A Match block's criteria (exec, originalhost, user, …) are not modelled here, and one that
  // routes this alias is indistinguishable from one that does not.
  if (claims.hasMatchBlock) {
    return true
  }
  return claims.hostPatternGroups.some((patterns) =>
    // A negation makes the whole group uncertain: `Host * !prod` still routes every other alias,
    // so skipping both the catch-all and the `!` would answer "unclaimed" for one that is claimed.
    patterns.some((pattern) => pattern.startsWith('!'))
      ? true
      : patterns.some(
          (pattern) =>
            !isCatchAllHostPattern(pattern) && matchesHostPattern(pattern, normalizedAlias)
        )
  )
}

/** `Host *` — the block every alias matches, which is exactly the one that proves nothing. */
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

// Bounds how long an edit to an Included file can go unnoticed; buildSshArgs runs per remote
// command, so re-expanding Includes every time is not an option.
const CLAIM_CACHE_TTL_MS = 5_000

let cachedClaims: { key: string; readAt: number; claims: SshConfigAliasClaims } | null = null

export function invalidateSshConfigAliasClaimCache(): void {
  cachedClaims = null
}

/**
 * Parse of `~/.ssh/config` (Includes expanded), or null when it cannot be read.
 *
 * Null and empty are different answers here: an absent or unreadable file is the uncertainty case,
 * while a readable file with no matching block is the proof {@link sshConfigMayClaimAlias} needs.
 */
export function loadUserSshConfigAliasClaims(): SshConfigAliasClaims | null {
  const configPath = join(homedir(), '.ssh', 'config')
  try {
    if (!existsSync(configPath)) {
      return null
    }
    // Why key on the root file only: an edited Include can go unnoticed, so the cache also expires.
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

/** Convenience wrapper over the two above; used where the caller has no claims to inject. */
export function mayUserSshConfigClaimAlias(alias: string): boolean {
  return sshConfigMayClaimAlias(alias, loadUserSshConfigAliasClaims())
}
