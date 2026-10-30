/** Linux /proc exposes PID-reuse-safe spawn tokens; macOS/Windows return unknown (null).
 * An empty result there could release a live reservation and admit a second writer. */

import { readFile, readdir } from 'node:fs/promises'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../../../shared/agent-session-caller-env'
import { spawnTokenFromEnvironBlock } from './agent-session-spawn-token-readback'

export type AgentSessionSpawnTokenScan = ReadonlyMap<string, readonly number[]>

/** Observed tokens, or null when enumeration is unavailable. */
export async function scanAgentSessionSpawnTokenProcesses(
  platform: NodeJS.Platform = process.platform,
  variable: string = ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV
): Promise<AgentSessionSpawnTokenScan | null> {
  if (platform !== 'linux') {
    return null
  }
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return null
  }
  const observed = new Map<string, number[]>()
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      continue
    }
    let token: string | null
    try {
      token = spawnTokenFromEnvironBlock(await readFile(`/proc/${pid}/environ`, 'utf-8'), variable)
    } catch {
      // A process that exited mid-scan, or one this user may not read, is not evidence either way.
      continue
    }
    if (token === null) {
      continue
    }
    observed.set(token, [...(observed.get(token) ?? []), pid])
  }
  return observed
}

/** Matching PIDs, or null when enumeration is unavailable. */
export async function findAgentSessionSpawnTokenProcesses(
  spawnToken: string,
  scan: () => Promise<AgentSessionSpawnTokenScan | null> = scanAgentSessionSpawnTokenProcesses
): Promise<number[] | null> {
  const observed = await scan()
  return observed === null ? null : [...(observed.get(spawnToken) ?? [])]
}
