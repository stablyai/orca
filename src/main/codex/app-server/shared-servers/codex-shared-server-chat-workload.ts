import { readFile } from 'node:fs/promises'
import { enumerateHostProcesses } from '../../../memory/host-process-index'
import { collectSubtree } from '../../../memory/process-index'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { spawnTokenFromEnvironBlock } from '../../../runtime/agent-session/ownership/agent-session-spawn-token-readback'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import {
  listCodexThreadBackgroundTerminals,
  terminateCodexBackgroundTerminals
} from '../../structured/background-work/codex-background-terminals'

const SWEEP_SETTLE_MS = 1_000

/** A dedicated server's close reaped the chat's whole tree; on a shared one, the chat's commands
 *  are stopped alone. Resolves whether they are proven gone. */
export async function stopCodexSharedChatWorkload(input: {
  rpc: Pick<CodexAppServerConnection, 'request'>
  threads: readonly string[]
  sessionId: string | null
  serverPid: number | undefined
  timeoutMs: number
  platform?: NodeJS.Platform
}): Promise<boolean> {
  let proven = true
  try {
    const terminals = (
      await Promise.all(
        input.threads.map((threadId) =>
          listCodexThreadBackgroundTerminals(input.rpc, threadId, input.timeoutMs)
        )
      )
    ).flat()
    if (terminals.length > 0) {
      const result = await terminateCodexBackgroundTerminals(input.rpc, terminals, {
        timeoutMs: input.timeoutMs,
        isCurrent: () => true
      })
      proven = !result.survived
    }
  } catch {
    proven = false
  }
  if ((input.platform ?? process.platform) === 'linux' && input.sessionId && input.serverPid) {
    proven = (await stopTaggedLinuxProcesses(input.serverPid, input.sessionId)) && proven
  }
  return proven
}

async function taggedWith(pid: number, sessionId: string): Promise<boolean> {
  try {
    const block = await readFile(`/proc/${pid}/environ`, 'utf-8')
    return spawnTokenFromEnvironBlock(block, ORCA_AGENT_SESSION_ID_ENV) === sessionId
  } catch {
    return false
  }
}

/** Codex runs the chat's commands with its ORCA_AGENT_SESSION_ID, so whatever a command left
 *  under the server (outside Codex's own terminal list) is found by that tag and stopped. */
async function stopTaggedLinuxProcesses(serverPid: number, sessionId: string): Promise<boolean> {
  const find = async (): Promise<number[]> => {
    const index = await enumerateHostProcesses({ trackCpu: false })
    const tagged: number[] = []
    for (const pid of collectSubtree(index, serverPid)) {
      if (pid !== serverPid && (await taggedWith(pid, sessionId))) {
        tagged.push(pid)
      }
    }
    return tagged
  }
  try {
    const found = await find()
    if (found.length === 0) {
      return true
    }
    for (const pid of found) {
      // Re-read the tag just before signalling, so a reused pid is never hit.
      if (await taggedWith(pid, sessionId)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, SWEEP_SETTLE_MS))
    return (await find()).length === 0
  } catch {
    return false
  }
}
