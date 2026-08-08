import { isShellProcess } from '../../shared/agent-detection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AiVaultSessionLiveness } from '../../shared/ai-vault-session-deletion'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { lstat } from 'node:fs/promises'
import { parseAgentSessionFileCached } from './session-scanner-parse-cache'

const MAX_LIVENESS_PROCESSES = 512
const PROCESS_INSPECTION_CONCURRENCY = 8

type ProcessInspection = {
  available: boolean
  process: string | null
}

type AgentProcessInspection = 'target-agent' | 'unknown' | 'other'

export type AiVaultSessionLivenessDependencies = {
  deadlineMs?: number
  listProcesses: () => Promise<PtyProcessInfo[]>
  getStatusSnapshot: () => AgentStatusIpcPayload[]
  inspectForegroundProcess: (ptyId: string) => Promise<ProcessInspection>
  getStatusPtyId: (status: AgentStatusIpcPayload) => string | null
  getAgentHint: (process: PtyProcessInfo) => string | null
}

export type AiVaultSessionIdentityRead =
  | { outcome: 'found'; sessionId: string }
  | { outcome: 'missing' }
  | { outcome: 'unknown' }

/** Binds the requested identity to the validated transcript on disk. */
export async function readAiVaultSessionIdentity(target: {
  agent: AiVaultAgent
  sessionId: string | undefined
  filePath: string
}): Promise<AiVaultSessionIdentityRead> {
  try {
    const fileStats = await lstat(target.filePath)
    if (!fileStats.isFile()) {
      return { outcome: 'unknown' }
    }
    const session = await parseAgentSessionFileCached(
      {
        agent: target.agent,
        file: {
          path: target.filePath,
          mtimeMs: fileStats.mtimeMs,
          modifiedAt: fileStats.mtime.toISOString(),
          sizeBytes: fileStats.size
        },
        codexHome: null
      },
      process.platform
    )
    return session?.sessionId && session.sessionId === target.sessionId
      ? { outcome: 'found', sessionId: session.sessionId }
      : { outcome: 'unknown' }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { outcome: 'missing' }
      : { outcome: 'unknown' }
  }
}

function isLocalStatus(status: AgentStatusIpcPayload): boolean {
  return status.connectionId === null || isWslHookRelayConnectionId(status.connectionId)
}

function isValidSessionId(sessionId: string | undefined): sessionId is string {
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    sessionId.length <= 512 &&
    sessionId.trim() === sessionId
  )
}

async function inspectInBatches<T>(
  values: readonly T[],
  inspect: (value: T) => Promise<AgentProcessInspection>,
  deadlineMs?: number
): Promise<AgentProcessInspection[]> {
  const results: AgentProcessInspection[] = []
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        results[index] = 'unknown'
        continue
      }
      results[index] = await inspect(values[index]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PROCESS_INSPECTION_CONCURRENCY, values.length) }, worker)
  )
  return results
}

/** Resolves owning-runtime liveness without treating unavailable evidence as absence. */
export async function resolveAiVaultSessionLiveness(
  target: { agent: AiVaultAgent; sessionId: string | undefined },
  deps: AiVaultSessionLivenessDependencies
): Promise<AiVaultSessionLiveness> {
  if (!isValidSessionId(target.sessionId)) {
    return 'unknown'
  }

  let processes: PtyProcessInfo[]
  try {
    processes = await deps.listProcesses()
  } catch {
    return 'unknown'
  }
  if (processes.length > MAX_LIVENESS_PROCESSES) {
    return 'unknown'
  }

  const processInspections = await inspectInBatches(
    processes,
    async (process) => {
      let inspection: ProcessInspection
      try {
        inspection = await deps.inspectForegroundProcess(process.id)
      } catch {
        return 'unknown'
      }
      if (!inspection.available) {
        return 'unknown'
      }

      const recognizedAgent = recognizeAgentProcess(inspection.process)?.agent ?? null
      const hintedAgent = deps.getAgentHint(process)
      const ownsTargetAgent =
        recognizedAgent === target.agent ||
        (recognizedAgent === null &&
          (inspection.process === null || !isShellProcess(inspection.process)) &&
          hintedAgent === target.agent)
      if (!ownsTargetAgent) {
        return 'other'
      }
      return 'target-agent'
    },
    deps.deadlineMs
  )

  let localStatuses: AgentStatusIpcPayload[]
  try {
    localStatuses = deps.getStatusSnapshot().filter(isLocalStatus)
  } catch {
    return 'unknown'
  }
  const processIds = new Set(processes.map((process) => process.id))
  const hasUnmatchedTargetStatus = localStatuses.some(
    (status) =>
      status.agentType === target.agent &&
      status.providerSession?.id === target.sessionId &&
      !processIds.has(deps.getStatusPtyId(status) ?? '')
  )
  if (hasUnmatchedTargetStatus) {
    return 'unknown'
  }

  const results = processInspections.map((inspection, index) => {
    if (inspection !== 'target-agent') {
      return inspection
    }
    const identities = localStatuses.filter(
      (status) =>
        status.agentType === target.agent && deps.getStatusPtyId(status) === processes[index]!.id
    )
    if (identities.some((status) => status.providerSession?.id === target.sessionId)) {
      return 'live'
    }
    return identities.some((status) => status.providerSession) ? 'other' : 'unknown'
  })
  if (results.includes('live')) {
    return 'live'
  }
  return results.includes('unknown') ? 'unknown' : 'not-live'
}
