// Initialize under a disposable home to verify the pinned server without signing in.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAcpAgentConnection, type AcpAgentConnection } from '../acp/acp-agent-connection'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import {
  AgentModelCatalogProbeError,
  runAgentModelCatalogSession
} from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import {
  ManagedRuntimeStartError,
  type ManagedRuntimeStartFailure
} from '../node-runtime/managed-runtime-release'
import type { ProviderProcessExit } from '../provider-process/managed-provider-process'
import { providerRequestTimeoutOf } from '../provider-process/provider-request-timeout'
import { supervisedProviderSpawnFailure } from '../provider-process/provider-spawn-failure-report'
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
  const probe: { connection?: AcpAgentConnection; exit?: ProviderProcessExit } = {}
  let failure: { cause: unknown; observed: ManagedRuntimeStartFailure | null } | null = null
  try {
    const initialized = await runAgentModelCatalogSession(
      () => {
        probe.connection = createAcpAgentConnection(
          {
            command,
            args: process.platform === 'linux' ? ['--uid='] : [],
            cwd: home,
            env: { ...ANTIGRAVITY_ACP_ENV, GEMINI_HOME: home, TMPDIR: home, TEMP: home, TMP: home },
            envToDelete: scrubAntigravityAcpEnvironment({}, process.env)
          },
          {
            onExit: (_error, { expected, exit }) => {
              if (!expected && !exit.processless) {
                probe.exit = exit
              }
            }
          }
        )
        return probe.connection
      },
      (started) => started.initialize(),
      { label: 'Antigravity', timeoutMs: PROBE_TIMEOUT_MS, signal }
    )
    if (!isPinnedServer(initialized, version)) {
      const answered = initialized.agentInfo?.version
      failure = {
        cause: new Error(`It did not answer as Antigravity ${version}`),
        observed:
          typeof answered === 'string' && answered !== version
            ? { kind: 'version', answered, expected: version }
            : null
      }
    }
  } catch (error) {
    failure = { cause: error, observed: await observedFailure(error, probe) }
  }
  if (probe.connection && !probe.connection.exited) {
    failure = {
      cause: new Error('Its exit was not proven after the check', { cause: failure?.cause }),
      observed: failure?.observed ?? null
    }
  }
  await rm(home, { recursive: true, force: true })
  if (failure !== null) {
    throw new ManagedRuntimeStartError(
      'Antigravity could not start on this host.',
      failure.observed,
      { cause: failure.cause }
    )
  }
}

async function observedFailure(
  error: unknown,
  probe: { connection?: AcpAgentConnection; exit?: ProviderProcessExit }
): Promise<ManagedRuntimeStartFailure | null> {
  // The initialize request's own deadline usually fires before the probe's.
  const requestTimeout = providerRequestTimeoutOf(error)
  if (requestTimeout) {
    return { kind: 'timeout', timeoutMs: requestTimeout.timeoutMs }
  }
  if (error instanceof AgentModelCatalogProbeError && error.reason === 'timeout') {
    return { kind: 'timeout', timeoutMs: PROBE_TIMEOUT_MS }
  }
  if (!probe.exit || !probe.connection) {
    return null
  }
  const stderr = await probe.connection.stderrTailAfterExit()
  return supervisedProviderSpawnFailure(probe.exit.code, stderr)
    ? null
    : { kind: 'exit', exit: probe.exit, stderr }
}
