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

type ProbeLaunch = {
  command: string
  args: string[]
  env: Record<string, string>
  envToDelete: string[]
}

/** What one initialize from a disposable folder settled with; `observed` only when requested. */
type InitializeOutcome = {
  initialized: InitializeResponse | null
  failed: boolean
  failure: unknown
  observed: ManagedRuntimeStartFailure | null
}

type ProbeConnection = { connection?: AcpAgentConnection; exit?: ProviderProcessExit }

type InitializeCheck = (
  connection: AcpAgentConnection,
  initialized: InitializeResponse,
  folder: string
) => Promise<void>

async function initializeFromDisposableFolder(
  launch: (folder: string) => ProbeLaunch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  options: { observe: boolean; check?: InitializeCheck }
): Promise<InitializeOutcome> {
  const { observe, check } = options
  // Keep the server's working folder, and any home inside it, together for cleanup.
  const folder = await mkdtemp(join(tmpdir(), 'orca-antigravity-probe-'))
  const probe: ProbeConnection = {}
  const outcome: InitializeOutcome = {
    initialized: null,
    failed: false,
    failure: null,
    observed: null
  }
  try {
    outcome.initialized = await runAgentModelCatalogSession(
      () => {
        probe.connection = createAcpAgentConnection(
          { ...launch(folder), cwd: folder },
          observe
            ? {
                onExit: (_error, { expected, exit }) => {
                  // Orca closing the check, or a spawn that never ran, says nothing about the runtime.
                  if (!expected && !exit.processless) {
                    probe.exit = exit
                  }
                }
              }
            : {}
        )
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
    outcome.failed = true
    outcome.failure = error
    if (observe) {
      outcome.observed = await observedStartFailure(error, probe, timeoutMs)
    }
  }
  if (probe.connection && !probe.connection.exited) {
    outcome.failure = new Error(
      'Its exit was not proven after the check',
      outcome.failed ? { cause: outcome.failure } : undefined
    )
    outcome.failed = true
  }
  await rm(folder, { recursive: true, force: true })
  return outcome
}

async function observedStartFailure(
  error: unknown,
  probe: ProbeConnection,
  timeoutMs: number
): Promise<ManagedRuntimeStartFailure | null> {
  // The initialize request's own deadline usually fires before the check's.
  const requestTimeout = providerRequestTimeoutOf(error)
  if (requestTimeout) {
    return { kind: 'timeout', timeoutMs: requestTimeout.timeoutMs }
  }
  if (error instanceof AgentModelCatalogProbeError && error.reason === 'timeout') {
    return { kind: 'timeout', timeoutMs }
  }
  if (!probe.exit || !probe.connection) {
    return null
  }
  const stderr = await probe.connection.stderrTailAfterExit()
  // A supervisor's spawn report is a missing launch, not the runtime's own exit.
  return supervisedProviderSpawnFailure(probe.exit.code, stderr)
    ? null
    : { kind: 'exit', exit: probe.exit, stderr }
}

/** Initializes from a disposable folder, then runs `check` there within the same deadline; rejects
 *  unless the server's exit is proven afterwards. */
export async function initializeAntigravityAcp(
  launch: (folder: string) => ProbeLaunch,
  timeoutMs: number,
  signal?: AbortSignal,
  check?: InitializeCheck
): Promise<InitializeResponse> {
  const outcome = await initializeFromDisposableFolder(launch, timeoutMs, signal, {
    observe: false,
    ...(check ? { check } : {})
  })
  if (outcome.failed || !outcome.initialized) {
    throw outcome.failure
  }
  return outcome.initialized
}

/** Require the pinned initialize response and proven exit before accepting an installation. */
export async function probeAntigravityAcpServer(
  command: string,
  version: string,
  signal: AbortSignal
): Promise<void> {
  const outcome = await initializeFromDisposableFolder(
    (home) => ({
      command,
      args: process.platform === 'linux' ? ['--uid='] : [],
      env: { ...ANTIGRAVITY_ACP_ENV, GEMINI_HOME: home, TMPDIR: home, TEMP: home, TMP: home },
      envToDelete: scrubAntigravityAcpEnvironment({}, process.env)
    }),
    PROBE_TIMEOUT_MS,
    signal,
    { observe: true }
  )
  let { failed, failure, observed } = outcome
  const { initialized } = outcome
  if (initialized && !isPinnedServer(initialized, version)) {
    const answered = initialized.agentInfo?.version
    if (typeof answered === 'string' && answered !== version) {
      observed = { kind: 'version', answered, expected: version }
    }
    if (!failed) {
      failed = true
      failure = new Error(`It did not answer as Antigravity ${version}`)
    }
  }
  if (failed) {
    throw new ManagedRuntimeStartError('Antigravity could not start on this host.', observed, {
      cause: failure
    })
  }
}
