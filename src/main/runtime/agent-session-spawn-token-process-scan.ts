/**
 * Host scan for processes carrying an Orca agent-session spawn token.
 *
 * The token is the only PID-reuse-safe identity element a child is guaranteed to carry, and it
 * lives in the child's environment — which only Linux lets another process read (`/proc/<pid>/environ`).
 * macOS and Windows answer `null`, meaning "this host cannot enumerate", NEVER "no process carries
 * it": reporting an empty result there would free a reservation whose child is alive and hand a
 * second writer to the same provider session.
 */

import { readFile, readdir } from 'node:fs/promises'
import { CODEX_SPAWN_TOKEN_ENV } from '../codex/codex-structured-owner-identity'
import { spawnTokenFromEnvironBlock } from './agent-session-spawn-token-readback'

export type AgentSessionSpawnTokenScan = ReadonlyMap<string, readonly number[]>

export type AgentSessionSpawnTokenScanEvidence =
  | { status: 'verified'; processes: AgentSessionSpawnTokenScan }
  | { status: 'unverifiable'; processes: null; platform: NodeJS.Platform }

/** Tokens observed on this host, or null when the platform cannot answer at all. */
export async function scanAgentSessionSpawnTokenProcesses(
  platform: NodeJS.Platform = process.platform,
  variable: string = CODEX_SPAWN_TOKEN_ENV
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

/**
 * Diagnostic evidence only. A null result is deliberately typed as
 * `unverifiable`, not as an empty process set; callers must never use this
 * Linux read-back as ownership or orphan-reaping proof.
 */
export async function scanAgentSessionSpawnTokenEvidence(
  platform: NodeJS.Platform = process.platform,
  variable: string = CODEX_SPAWN_TOKEN_ENV
): Promise<AgentSessionSpawnTokenScanEvidence> {
  const processes = await scanAgentSessionSpawnTokenProcesses(platform, variable)
  return processes === null
    ? { status: 'unverifiable', processes: null, platform }
    : { status: 'verified', processes }
}

/** Pids carrying one specific token, or null when the host could not enumerate. */
export async function findAgentSessionSpawnTokenProcesses(
  spawnToken: string,
  scan: () => Promise<AgentSessionSpawnTokenScan | null> = scanAgentSessionSpawnTokenProcesses
): Promise<number[] | null> {
  const observed = await scan()
  return observed === null ? null : [...(observed.get(spawnToken) ?? [])]
}
