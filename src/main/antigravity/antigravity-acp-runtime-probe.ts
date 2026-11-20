// Initialize `agy acp` from a disposable folder to check it without starting a chat.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAcpAgentConnection,
  type AcpAgentConnection
} from '../acp/process/acp-agent-connection'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

type ProbeLaunch = {
  command: string
  args: string[]
  env: Record<string, string>
  envToDelete: string[]
}

type InitializeCheck = (
  connection: AcpAgentConnection,
  initialized: InitializeResponse,
  folder: string
) => Promise<void>

/** Initializes from a disposable folder, then runs `check` there within the same deadline; rejects
 *  unless the process's exit is proven afterwards. */
export async function initializeAntigravityAcp(
  launch: (folder: string) => ProbeLaunch,
  timeoutMs: number,
  signal?: AbortSignal,
  check?: InitializeCheck
): Promise<InitializeResponse> {
  // Keep the working folder, and any home inside it, together for cleanup.
  const folder = await mkdtemp(join(tmpdir(), 'orca-antigravity-probe-'))
  let connection: AcpAgentConnection | undefined
  let initialized: InitializeResponse | null = null
  let failure: unknown = null
  try {
    initialized = await runAgentModelCatalogSession(
      () => {
        connection = createAcpAgentConnection({ ...launch(folder), cwd: folder }, {})
        return connection
      },
      async (started) => {
        const response = await started.initialize()
        await check?.(started, response, folder)
        return response
      },
      { label: 'Antigravity', timeoutMs, ...(signal ? { signal } : {}) }
    )
  } catch (error) {
    failure = error
  }
  // Windows single-file programs can briefly retain DLLs they unpacked into this folder.
  const exited = !connection || connection.exited
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  if (!exited) {
    throw new Error('Its exit was not proven after the check', failure ? { cause: failure } : {})
  }
  if (!initialized) {
    throw failure
  }
  return initialized
}
