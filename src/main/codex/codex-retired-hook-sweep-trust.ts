import { existsSync, readFileSync } from 'node:fs'
import type { HookDefinition } from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntriesFromContent,
  removeHookTrustEntriesFromContent,
  type CodexTrustEntry
} from './config-toml-trust'
import { moveHookTrustContent } from './config-toml-hook-trust-edit'
import { CodexConfigTomlEditRefusedError } from './codex-config-toml-checked-edit'
import { getMovedCodexUserHookTrust } from './codex-user-hook-trust-moves'

/**
 * The config.toml side of sweeping retired Orca entries from ~/.codex/hooks.json:
 * the user hooks the removal shifts carry their trust to the new keys, and the
 * retired entries' own self-computed trust goes.
 */
export type RetiredHookSweepTrustPlan =
  | { kind: 'unchanged' }
  | { kind: 'edit'; previous: string; next: string }
  | { kind: 'refused'; error: CodexConfigTomlEditRefusedError }

export function planRetiredHookSweepTrust(args: {
  tomlPath: string
  hooksPath: string
  beforeHooks: Record<string, HookDefinition[]>
  afterHooks: Record<string, HookDefinition[]>
  retiredTrustEntries: readonly CodexTrustEntry[]
}): RetiredHookSweepTrustPlan {
  if (!existsSync(args.tomlPath)) {
    return { kind: 'unchanged' }
  }
  const raw = readFileSync(args.tomlPath, 'utf-8')
  const previous = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  try {
    const moves = getMovedCodexUserHookTrust(args.hooksPath, args.beforeHooks, args.afterHooks)
    const moved = moves.length > 0 ? moveHookTrustContent(previous, moves) : previous
    // Why after the move: a shifted user hook may now hold a retired entry's key.
    const trust = readHookTrustEntriesFromContent(moved)
    const ownedKeys = args.retiredTrustEntries
      .filter(
        (entry) => trust.get(computeTrustKey(entry))?.trustedHash === computeTrustedHash(entry)
      )
      .map(computeTrustKey)
    const next = ownedKeys.length > 0 ? removeHookTrustEntriesFromContent(moved, ownedKeys) : moved
    return next === previous ? { kind: 'unchanged' } : { kind: 'edit', previous, next }
  } catch (error) {
    if (!(error instanceof CodexConfigTomlEditRefusedError)) {
      throw error
    }
    return {
      kind: 'refused',
      error: error.configPath === null ? error.forConfigPath(args.tomlPath) : error
    }
  }
}
