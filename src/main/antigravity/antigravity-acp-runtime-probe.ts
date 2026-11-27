// Initialize agy from a disposable folder, to ask what it can serve without starting a chat.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAcpAgentConnection,
  type AcpAgentConnection
} from '../acp/process/acp-agent-connection'
import type { Implementation, InitializeResponse } from '../acp/generated/acp-protocol.generated'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { waitForProviderExitUntil } from '../provider-process/provider-process-exit-deadline'

// agy gets one fixed ACP client identity on every connection.
export const AGY_ACP_CLIENT_INFO: Implementation = { name: 'zed', version: '0.0.0' }

// A close can return before agy's exit is seen; a check that answered still waits for that proof.
const EXIT_PROOF_WAIT_MS = 5_000

type ProbeLaunch = {
  command: string
  args: string[]
  env: Record<string, string>
  envToDelete: string[]
}

/** What one initialize from a disposable folder settled with. */
type InitializeOutcome = {
  initialized: InitializeResponse | null
  failed: boolean
  failure: unknown
}

type InitializeCheck = (
  connection: AcpAgentConnection,
  initialized: InitializeResponse,
  folder: string
) => Promise<void>

async function initializeFromDisposableFolder(
  launch: (folder: string) => ProbeLaunch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  check: InitializeCheck | undefined
): Promise<InitializeOutcome> {
  const folder = await mkdtemp(join(tmpdir(), 'orca-antigravity-probe-'))
  let connection: AcpAgentConnection | undefined
  const outcome: InitializeOutcome = { initialized: null, failed: false, failure: null }
  try {
    outcome.initialized = await runAgentModelCatalogSession(
      () => {
        connection = createAcpAgentConnection(
          { ...launch(folder), cwd: folder },
          { clientInfo: AGY_ACP_CLIENT_INFO }
        )
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
    outcome.failed = true
    outcome.failure = error
  }
  if (connection && !connection.exited) {
    await waitForProviderExitUntil(connection, EXIT_PROOF_WAIT_MS)
  }
  if (connection && !connection.exited) {
    outcome.failure = new Error(
      'Its exit was not proven after the check',
      outcome.failed ? { cause: outcome.failure } : undefined
    )
    outcome.failed = true
  }
  // Windows single-file runtimes can briefly retain DLLs they unpacked into this folder.
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  return outcome
}

/** Initializes from a disposable folder, then runs `check` there within the same deadline; rejects
 *  unless agy's exit is proven afterwards. */
export async function initializeAntigravityAcp(
  launch: (folder: string) => ProbeLaunch,
  timeoutMs: number,
  signal?: AbortSignal,
  check?: InitializeCheck
): Promise<InitializeResponse> {
  const outcome = await initializeFromDisposableFolder(launch, timeoutMs, signal, check)
  if (outcome.failed || !outcome.initialized) {
    throw outcome.failure
  }
  return outcome.initialized
}
