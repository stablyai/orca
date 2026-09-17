import type {
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { VerifiedAgentDiscovery } from '../../shared/agent-status-verified-discovery'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { isResumableTuiAgent, type ResumableTuiAgent } from '../../shared/agent-session-resume'
import { resolveRemoteForegroundEvidence } from './agent-foreground-process'

const MAX_ANCESTRY_DEPTH = 256

type ProcessDiscoveryInput = {
  ptyId: string
  ptyIncarnationId: string
  rootProcessId: number
  authorityGeneration: string
  observationEpoch: number
  capturedAgeMs: number
  surface: AgentSessionSurfaceBinding
  providerIdentity: VerifiedAgentDiscovery['providerIdentity']
  createClaim: (args: {
    agent: ResumableTuiAgent
    launchIdentity: string
    canonicalWorktreeId: string
  }) => AgentSessionExecutionClaim
  rows: readonly ProcessTableRow[]
  platform?: NodeJS.Platform
}

function buildAncestry(
  rows: readonly ProcessTableRow[],
  rootProcessId: number,
  processId: number
): Pick<VerifiedAgentDiscovery, 'ancestry' | 'process'> | null {
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]))
  const process = rowsByPid.get(processId)
  if (!process?.startTime || process.ppid <= 0) {
    return null
  }
  const reversed: { pid: number; startTime: string }[] = []
  const seen = new Set<number>([processId])
  let cursor = rowsByPid.get(process.ppid)
  while (cursor && reversed.length < MAX_ANCESTRY_DEPTH) {
    if (seen.has(cursor.pid) || !cursor.startTime) {
      return null
    }
    seen.add(cursor.pid)
    reversed.push({ pid: cursor.pid, startTime: cursor.startTime })
    if (cursor.pid === rootProcessId) {
      // Indexed rather than `toReversed()`: this module reaches the Node 18 relay bundle,
      // where the ES2023 array-copy methods do not exist.
      const chain: { pid: number; startTime: string }[] = []
      for (let index = reversed.length - 1; index >= 0; index -= 1) {
        chain.push(reversed[index])
      }
      const parent = chain.at(-1)
      return parent
        ? {
            ancestry: {
              parent,
              chain,
              relation: chain.length === 1 ? 'direct-child' : 'descendant'
            },
            process: { pid: process.pid, startTime: process.startTime, parentPid: process.ppid }
          }
        : null
    }
    cursor = rowsByPid.get(cursor.ppid)
  }
  return null
}

function hasRecognizedAgentAncestor(
  rows: readonly ProcessTableRow[],
  ancestry: VerifiedAgentDiscovery['ancestry']
): boolean {
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]))
  return ancestry.chain.some((identity) =>
    recognizeAgentProcess(rowsByPid.get(identity.pid)?.command)
  )
}

/** Build a discovery only from one complete execution-host process-table capture. */
export function buildVerifiedAgentProcessDiscovery(
  input: ProcessDiscoveryInput
): VerifiedAgentDiscovery | null {
  const evidence = resolveRemoteForegroundEvidence(
    { rootPid: input.rootProcessId },
    {
      ptyId: input.ptyId,
      ptyIncarnationId: input.ptyIncarnationId,
      authorityGeneration: input.authorityGeneration,
      observationEpoch: input.observationEpoch,
      capturedAgeMs: input.capturedAgeMs,
      platform: input.platform
    },
    input.rows
  )
  if (
    evidence.verdict !== 'live' ||
    evidence.fence.platform !== 'posix' ||
    !evidence.fence.process ||
    !evidence.processName
  ) {
    return null
  }
  const processIdentity = recognizeAgentProcess(evidence.processName)
  const ancestry = buildAncestry(input.rows, input.rootProcessId, evidence.fence.process.pid)
  const agent = input.providerIdentity.agent
  if (
    !processIdentity ||
    processIdentity.agent !== agent ||
    !isResumableTuiAgent(agent) ||
    !ancestry ||
    hasRecognizedAgentAncestor(input.rows, ancestry.ancestry) ||
    input.providerIdentity.observation.process.pid !== ancestry.process.pid ||
    input.providerIdentity.observation.process.startTime !== ancestry.process.startTime
  ) {
    return null
  }
  const claim = input.createClaim({
    agent,
    launchIdentity: [
      'discovered-process-v1',
      input.ptyIncarnationId,
      String(ancestry.process.pid),
      ancestry.process.startTime
    ].join(':'),
    canonicalWorktreeId: input.surface.worktreeId
  })
  return {
    claim,
    surface: input.surface,
    evidence,
    providerIdentity: {
      ...input.providerIdentity,
      session: { ...input.providerIdentity.session },
      observation: {
        ...input.providerIdentity.observation,
        process: { ...input.providerIdentity.observation.process }
      }
    },
    ...ancestry
  }
}

export function processTableContainsDiscoveredOwner(
  rows: readonly ProcessTableRow[],
  process: Pick<NonNullable<AgentSessionOwnerBinding['discoveryProcess']>, 'pid' | 'startTime'>
): boolean {
  return rows.some((row) => row.pid === process.pid && row.startTime === process.startTime)
}
