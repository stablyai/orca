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

/** Require the pinned initialize response and proven exit before accepting an installation. */
export async function probeAntigravityAcpServer(
  command: string,
  version: string,
  signal: AbortSignal
): Promise<void> {
  // Keep the server’s home and extracted runtime together for cleanup.
  const home = await mkdtemp(join(tmpdir(), 'orca-antigravity-probe-'))
  const probe: { connection?: AcpAgentConnection } = {}
  let answer: unknown = null
  try {
    const initialized = await runAgentModelCatalogSession(
      () => {
        probe.connection = createAcpAgentConnection({
          command,
          args: process.platform === 'linux' ? ['--uid='] : [],
          cwd: home,
          env: { ...ANTIGRAVITY_ACP_ENV, GEMINI_HOME: home, TMPDIR: home, TEMP: home, TMP: home },
          envToDelete: scrubAntigravityAcpEnvironment({}, process.env)
        })
        return probe.connection
      },
      (started) => started.initialize(),
      { label: 'Antigravity', timeoutMs: PROBE_TIMEOUT_MS, signal }
    )
    if (!isPinnedServer(initialized, version)) {
      answer = new Error(`It did not answer as Antigravity ${version}`)
    }
  } catch (error) {
    answer = error
  }
  const failure =
    probe.connection && !probe.connection.exited
      ? new Error('Its exit was not proven after the check')
      : answer
  await rm(home, { recursive: true, force: true })
  if (failure !== null) {
    throw new Error('Antigravity could not start on this host.', { cause: failure })
  }
}
