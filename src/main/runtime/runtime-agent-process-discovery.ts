import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type { ResumableTuiAgent } from '../../shared/agent-session-resume'
import { getStrictProcessTableSnapshotWithAge } from '../../shared/process-table-snapshot-reader'
import {
  buildVerifiedAgentProcessDiscovery,
  processTableContainsDiscoveredOwner
} from '../providers/verified-agent-process-discovery'
import { agentSessionOwners } from '../ipc/pty/pane/agent-session-owners'
import { canRetireDiscoveredProcessFromObservation } from '../../shared/claimed-agent-pty-owner'
import {
  admitVerifiedAgentDiscovery,
  verifiedAgentProviderIdentitiesEqual,
  type VerifiedAgentDiscovery
} from '../../shared/agent-status-verified-discovery'
import type { ObservedAgentStatusPaneIdentity } from '../ipc/agent-status-ipc-boundary'
import type { AgentSessionClaimSigner } from './agent-session-claim-identity'
import type {
  RuntimeAgentSessionCommit,
  RuntimeAgentSessionInventoryReconciliation
} from './runtime-terminal-contracts'
import { makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'

export type RuntimeAgentProcessDiscoveryCandidate = {
  ptyId: string
  ptyIncarnationId: string
  rootProcessId: number
  surface: AgentSessionSurfaceBinding
  resolveProviderIdentity: () => VerifiedAgentDiscovery['providerIdentity'] | null
  invalidateProviderIdentity: () => void
  isCurrent: () => boolean
}

export function createRuntimeAgentProcessDiscoveryCandidate(args: {
  ptyId: string
  ptyIncarnationId: string
  rootProcessId: number
  surface: AgentSessionSurfaceBinding
  paneKey: string
  processIncarnation: string
  readObserved: (paneKey: string) => ObservedAgentStatusPaneIdentity
  readProviderIdentity: (paneKey: string) => VerifiedAgentDiscovery['providerIdentity'] | null
  invalidateProviderIdentity: (paneKey: string) => void
  isCurrent: () => boolean
}): RuntimeAgentProcessDiscoveryCandidate {
  return {
    ptyId: args.ptyId,
    ptyIncarnationId: args.ptyIncarnationId,
    rootProcessId: args.rootProcessId,
    surface: args.surface,
    resolveProviderIdentity: () =>
      resolveRuntimeAgentDiscoveryProviderIdentity({
        paneKey: args.paneKey,
        terminalHandle: args.surface.terminalHandle,
        processIncarnation: args.processIncarnation,
        readObserved: args.readObserved,
        readProviderIdentity: args.readProviderIdentity
      }),
    invalidateProviderIdentity: () => args.invalidateProviderIdentity(args.paneKey),
    isCurrent: args.isCurrent
  }
}

export function appendRuntimeAgentProcessDiscoveryCandidate(args: {
  candidates: RuntimeAgentProcessDiscoveryCandidate[]
  ptyId: string
  connectionId: string | null
  wslDistro?: string | null
  paneKey: string | null
  terminalHandle?: string
  ptyIncarnationId?: string
  rootProcessId?: number
  worktreeId: string
  readObserved: (paneKey: string) => ObservedAgentStatusPaneIdentity
  readProviderIdentity: (paneKey: string) => VerifiedAgentDiscovery['providerIdentity'] | null
  invalidateProviderIdentity: (paneKey: string) => void
  readCurrentPty: (ptyId: string) =>
    | {
        connected: boolean
        connectionId: string | null
        incarnationId?: string | null
        paneKey: string | null
      }
    | undefined
  readTerminalHandles: (ptyId: string) => readonly string[]
}): void {
  const parsedPane = args.paneKey ? parsePaneKey(args.paneKey) : null
  if (
    args.connectionId !== null ||
    args.wslDistro ||
    !args.paneKey ||
    !parsedPane ||
    !args.terminalHandle ||
    !args.ptyIncarnationId ||
    !args.rootProcessId
  ) {
    return
  }
  const paneKey = args.paneKey
  const terminalHandle = args.terminalHandle
  const ptyIncarnationId = args.ptyIncarnationId
  args.candidates.push(
    createRuntimeAgentProcessDiscoveryCandidate({
      ptyId: args.ptyId,
      ptyIncarnationId,
      rootProcessId: args.rootProcessId,
      surface: {
        worktreeId: args.worktreeId,
        tabId: parsedPane.tabId,
        leafId: parsedPane.leafId,
        terminalHandle
      },
      paneKey,
      processIncarnation: `${args.ptyId}:${ptyIncarnationId}`,
      readObserved: args.readObserved,
      readProviderIdentity: args.readProviderIdentity,
      invalidateProviderIdentity: args.invalidateProviderIdentity,
      isCurrent: () => {
        const current = args.readCurrentPty(args.ptyId)
        return Boolean(
          current?.connected &&
          current.connectionId === null &&
          current.incarnationId === ptyIncarnationId &&
          current.paneKey === paneKey &&
          args.readTerminalHandles(args.ptyId).includes(terminalHandle)
        )
      }
    })
  )
}

/** Join provider proof to the exact pane observation and PTY incarnation captured at hook ingest. */
export function resolveRuntimeAgentDiscoveryProviderIdentity(args: {
  paneKey: string
  terminalHandle: string
  processIncarnation: string
  readObserved: (paneKey: string) => ObservedAgentStatusPaneIdentity
  readProviderIdentity: (paneKey: string) => VerifiedAgentDiscovery['providerIdentity'] | null
}): VerifiedAgentDiscovery['providerIdentity'] | null {
  const observed = args.readObserved(args.paneKey)
  if (
    observed.kind !== 'observed' ||
    observed.terminalHandle !== args.terminalHandle ||
    observed.processIncarnation !== args.processIncarnation
  ) {
    return null
  }
  return args.readProviderIdentity(args.paneKey)
}

/** Run one local host capture and commit every proven manual agent through the owner registry. */
export async function admitRuntimeAgentProcessDiscoveries(args: {
  candidates: readonly RuntimeAgentProcessDiscoveryCandidate[]
  authorityGeneration: string
  observationEpoch: number
  platform?: NodeJS.Platform
  createClaim: (args: {
    agent: ResumableTuiAgent
    launchIdentity: string
    canonicalWorktreeId: string
  }) => AgentSessionExecutionClaim
  onCommitted: (args: {
    result: Awaited<ReturnType<typeof admitVerifiedAgentDiscovery>> & { admitted: true }
    candidate: RuntimeAgentProcessDiscoveryCandidate
  }) => void
  onReconciled: (owners: ReturnType<typeof agentSessionOwners.list>) => void
}): Promise<void> {
  const platform = args.platform ?? process.platform
  if (args.candidates.length === 0 || platform === 'win32') {
    return
  }
  const snapshot = await getStrictProcessTableSnapshotWithAge()
  for (const candidate of args.candidates) {
    if (!candidate.isCurrent()) {
      continue
    }
    const providerIdentity = candidate.resolveProviderIdentity()
    if (!providerIdentity) {
      continue
    }
    const staleDiscoveredOwners = agentSessionOwners
      .listForPty(candidate.ptyId)
      .filter(
        (owner) =>
          owner.discoveryProcess &&
          canRetireDiscoveredProcessFromObservation(owner.discoveryProcess, args) &&
          (owner.discoveryProcess.ptyIncarnationId !== candidate.ptyIncarnationId ||
            !processTableContainsDiscoveredOwner(snapshot.rows, owner.discoveryProcess))
      )
    const discovery = buildVerifiedAgentProcessDiscovery({
      ptyId: candidate.ptyId,
      ptyIncarnationId: candidate.ptyIncarnationId,
      rootProcessId: candidate.rootProcessId,
      authorityGeneration: args.authorityGeneration,
      observationEpoch: args.observationEpoch,
      capturedAgeMs: snapshot.capturedAgeMs,
      surface: candidate.surface,
      providerIdentity,
      createClaim: args.createClaim,
      rows: snapshot.rows,
      platform
    })
    if (!discovery) {
      for (const owner of staleDiscoveredOwners) {
        agentSessionOwners.release(candidate.ptyId, owner.generation)
      }
      continue
    }
    const result = await admitVerifiedAgentDiscovery({
      owners: agentSessionOwners,
      discovery,
      isLive: () =>
        candidate.isCurrent() &&
        verifiedAgentProviderIdentitiesEqual(
          providerIdentity,
          candidate.resolveProviderIdentity()
        ) &&
        processTableContainsDiscoveredOwner(snapshot.rows, {
          pid: discovery.process.pid,
          startTime: discovery.process.startTime
        })
    })
    if (result.admitted) {
      args.onCommitted({ result, candidate })
    } else {
      if (result.reason === 'agent_session_observation_stale') {
        candidate.invalidateProviderIdentity()
      }
      for (const owner of staleDiscoveredOwners) {
        agentSessionOwners.release(candidate.ptyId, owner.generation)
      }
    }
  }
  args.onReconciled(agentSessionOwners.list())
}

/** Discovery is bookkeeping and must never gate the inventory action that observed it. */
export function startRuntimeAgentProcessDiscoveries(args: {
  candidates: readonly RuntimeAgentProcessDiscoveryCandidate[]
  authorityGeneration: string
  observationEpoch: number
  claimSigner: AgentSessionClaimSigner
  onCommitted: ((commit: RuntimeAgentSessionCommit) => void) | null
  onReconciled: ((reconciliation: RuntimeAgentSessionInventoryReconciliation) => void) | null
}): void {
  void admitRuntimeAgentProcessDiscoveries({
    candidates: args.candidates,
    authorityGeneration: args.authorityGeneration,
    observationEpoch: args.observationEpoch,
    createClaim: ({ agent, launchIdentity, canonicalWorktreeId }) => {
      const principal =
        typeof process.getuid === 'function'
          ? `uid:${process.getuid()}`
          : `user:${process.env.USERNAME ?? ''}`
      return args.claimSigner.createFreshClaim({
        namespace: {
          machine: `native:${process.platform}`,
          principal,
          container: 'native',
          providerRoot: `profile-default:${agent}`
        },
        agent,
        launchIdentity,
        canonicalWorktreeId
      })
    },
    onCommitted: ({ result, candidate }) => {
      args.onCommitted?.({
        result,
        paneKey: makePaneKey(candidate.surface.tabId, candidate.surface.leafId),
        tabId: candidate.surface.tabId,
        leafId: candidate.surface.leafId,
        worktreeId: candidate.surface.worktreeId,
        connectionId: null,
        agentType: result.owner.claim.agent
      })
    },
    onReconciled: (owners) => {
      args.onReconciled?.({ owners, discoveries: [], complete: true, connectionId: null })
    }
  }).catch((error) => {
    console.warn('[runtime] verified agent discovery failed:', error)
  })
}
