import { resolveEffectiveCursorCommand } from '../../shared/cursor-command'
import type { TuiAgent } from '../../shared/types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  detectInstalledAgentCommandsWithShellPathHydration,
  detectRemoteAgentCommands
} from '../ipc/tui-agent-inventory-detection'

// Why: every launch/resume/draft path awaits this, and probing spawns shell
// detection or an SSH inventory RPC. Keep it short so a fresh install is picked
// up quickly while a burst of terminals shares one probe.
const CURSOR_COMMAND_CACHE_TTL_MS = 30_000
const CURSOR_COMMAND_CACHE_MAX_KEYS = 16

type CursorCommandCacheEntry = {
  command?: string | null
  expiresAt: number
  inflight?: Promise<string | null>
}

const cursorCommandCache = new Map<string, CursorCommandCacheEntry>()

export async function resolveRuntimeAgentCommandOverrides(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  connectionId?: string | null
  wslDistro?: string | null
  workspacePath: string
}): Promise<Partial<Record<TuiAgent, string>>> {
  if (args.agent !== 'cursor' || args.cmdOverrides.cursor?.trim()) {
    return args.cmdOverrides
  }
  try {
    const wslDistro = args.wslDistro?.trim() || parseWslUncPath(args.workspacePath)?.distro
    const command = await cachedCursorCommand(args.connectionId ?? null, wslDistro ?? null)
    return command ? { ...args.cmdOverrides, cursor: command } : args.cmdOverrides
  } catch {
    return args.cmdOverrides
  }
}

export function resetRuntimeCursorCommandCacheForTests(): void {
  cursorCommandCache.clear()
}

async function cachedCursorCommand(
  connectionId: string | null,
  wslDistro: string | null
): Promise<string | null> {
  const key = JSON.stringify({ connectionId, wslDistro })
  const existing = cursorCommandCache.get(key)
  if (existing?.inflight) {
    return existing.inflight
  }
  if (existing && existing.expiresAt > Date.now()) {
    return existing.command ?? null
  }
  const entry: CursorCommandCacheEntry = existing ?? { expiresAt: 0 }
  const inflight = detectCursorCommand(connectionId, wslDistro)
    .then((command) => {
      entry.command = command
      entry.expiresAt = Date.now() + CURSOR_COMMAND_CACHE_TTL_MS
      return command
    })
    .finally(() => {
      if (entry.inflight === inflight) {
        entry.inflight = undefined
      }
    })
  entry.inflight = inflight
  cursorCommandCache.delete(key)
  cursorCommandCache.set(key, entry)
  evictCursorCommandCache(key)
  return inflight
}

async function detectCursorCommand(
  connectionId: string | null,
  wslDistro: string | null
): Promise<string | null> {
  const inventory = connectionId
    ? await detectRemoteAgentCommands({ connectionId })
    : await detectInstalledAgentCommandsWithShellPathHydration(wslDistro ? { wslDistro } : {})
  return resolveEffectiveCursorCommand(null, inventory)
}

function evictCursorCommandCache(activeKey: string): void {
  while (cursorCommandCache.size > CURSOR_COMMAND_CACHE_MAX_KEYS) {
    const candidate = [...cursorCommandCache.entries()].find(
      ([key, entry]) => key !== activeKey && !entry.inflight
    )
    if (!candidate) {
      return
    }
    cursorCommandCache.delete(candidate[0])
  }
}
