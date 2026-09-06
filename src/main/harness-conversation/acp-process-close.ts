import type { ClientSideConnection } from '@agentclientprotocol/sdk'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { killCodexAppServerProcessTree } from '../codex/codex-app-server-session'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'

export async function closeAcpConversationProcess(
  connection: ClientSideConnection,
  child: ReturnType<typeof spawnProcess>,
  sessionId: string | null,
  supportsClose: boolean
): Promise<void> {
  try {
    if (sessionId && supportsClose) {
      await waitForProcessExitUntil(
        connection.closeSession({ sessionId }).then(() => undefined),
        1_000
      )
    }
  } finally {
    child.kill('SIGTERM')
    await waitForProcessExitUntil(
      connection.closed.catch(() => undefined),
      1_000
    )
    if (child.exitCode === null) {
      killCodexAppServerProcessTree(child)
    }
  }
}
