/** Linux /proc exposes the child's PID-reuse-safe token even without recorded start time.
 * macOS/Windows return null: unavailable evidence proves neither liveness nor death. */

import { readFile } from 'node:fs/promises'
import type { AgentSessionProcessIdentity } from '../../../../shared/agent-session-record'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../../../shared/agent-session-caller-env'

export function spawnTokenFromEnvironBlock(
  block: string,
  variable: string = ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV
): string | null {
  for (const entry of block.split('\0')) {
    if (entry.startsWith(`${variable}=`)) {
      const value = entry.slice(variable.length + 1)
      return value.length > 0 ? value : null
    }
  }
  return null
}

export async function readEchoedAgentSessionSpawnToken(
  identity: AgentSessionProcessIdentity,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (platform !== 'linux') {
    return null
  }
  try {
    return spawnTokenFromEnvironBlock(await readFile(`/proc/${identity.pid}/environ`, 'utf-8'))
  } catch {
    return null
  }
}
