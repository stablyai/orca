// Initialize under a disposable home to verify the pinned server without signing in.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAcpAgentConnection, type AcpAgentConnection } from '../acp/acp-agent-connection'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { ANTIGRAVITY_ACP_ENV, scrubAntigravityAcpEnvironment } from './antigravity-acp-environment'

const PROBE_TIMEOUT_MS = 90_000

function isPinnedServer(initialized: InitializeResponse, version: string): boolean {
  const capabilities = initialized.agentCapabilities
  return (
    initialized.agentInfo?.name === 'antigravity-acp' &&
    initialized.agentInfo.version === version &&
    initialized.protocolVersion === 1 &&
    capabilities?.loadSession === true &&
    Boolean(capabilities.sessionCapabilities?.resume) &&
    Boolean(capabilities.auth?.logout) &&
    (initialized.authMethods ?? []).some((method) => method.id === 'oauth-personal')
  )
}

type ProbeLaunch = {
  command: string
  args: string[]
  env: Record<string, string>
  envToDelete: string[]
}

/** Initializes from a disposable folder, then runs `check` there within the same deadline; rejects
 *  unless the server's exit is proven afterwards. */
export async function initializeAntigravityAcp(
  launch: (folder: string) => ProbeLaunch,
  timeoutMs: number,
  signal?: AbortSignal,
  check?: (
    connection: AcpAgentConnection,
    initialized: InitializeResponse,
    folder: string
  ) => Promise<void>
): Promise<InitializeResponse> {
  // Keep the server's working folder, and any home inside it, together for cleanup.
  const folder = await mkdtemp(join(tmpdir(), 'orca-antigravity-probe-'))
  const probe: { connection?: AcpAgentConnection } = {}
  let initialized: InitializeResponse | null = null
  let failure: unknown = null
  try {
    initialized = await runAgentModelCatalogSession(
      () => {
        probe.connection = createAcpAgentConnection({ ...launch(folder), cwd: folder })
        return probe.connection
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
  if (probe.connection && !probe.connection.exited) {
    failure = new Error('Its exit was not proven after the check')
  }
  await rm(folder, { recursive: true, force: true })
  if (failure !== null || !initialized) {
    throw failure
  }
  return initialized
}

/** Require the pinned initialize response and proven exit before accepting an installation. */
export async function probeAntigravityAcpServer(
  command: string,
  version: string,
  signal: AbortSignal
): Promise<void> {
  let failure: unknown = null
  try {
    const initialized = await initializeAntigravityAcp(
      (home) => ({
        command,
        args: process.platform === 'linux' ? ['--uid='] : [],
        env: { ...ANTIGRAVITY_ACP_ENV, GEMINI_HOME: home, TMPDIR: home, TEMP: home, TMP: home },
        envToDelete: scrubAntigravityAcpEnvironment({}, process.env)
      }),
      PROBE_TIMEOUT_MS,
      signal
    )
    if (!isPinnedServer(initialized, version)) {
      failure = new Error(`It did not answer as Antigravity ${version}`)
    }
  } catch (error) {
    failure = error
  }
  if (failure !== null) {
    throw new Error('Antigravity could not start on this host.', { cause: failure })
  }
}
