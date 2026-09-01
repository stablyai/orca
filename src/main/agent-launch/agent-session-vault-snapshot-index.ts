import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  providerSessionKeyForResumableBase,
  type AgentSessionOwnershipKey,
  type ResumableTuiAgent
} from '../../shared/agent-session-resume'
import { isTuiAgent } from '../../shared/tui-agent-config'
import {
  canonicalAgentSessionTranscriptIdentity,
  transcriptPathConflictsWithWslTarget
} from './agent-session-transcript-identity'
import type { HostSessionLaunchRecord } from './agent-session-record-store'
import {
  AgentSessionVaultTargetIndex,
  vaultSessionKeyForRecord,
  type VaultSnapshotScanIdentity
} from './agent-session-vault-target-index'

export type VaultSnapshotOwnerResolution =
  | { kind: 'found'; sessionKey: AgentSessionOwnershipKey }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

const NODE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
])
const SNAPSHOT_MODES = new Set(['built-in', 'custom', 'safe-fallback'])
const CAPTURED_ENV_POLICIES = new Set(['full', 'withheld', 'none'])
const STARTUP_SHELLS = new Set(['posix', 'powershell', 'cmd'])

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}

function isExecutionHostId(value: unknown): value is AgentLaunchExecutionHostId {
  if (value === 'local') {
    return true
  }
  if (typeof value !== 'string' || !/^(?:ssh|runtime|wsl):.+$/.test(value)) {
    return false
  }
  if (!value.startsWith('wsl:')) {
    return true
  }
  try {
    return decodeURIComponent(value.slice('wsl:'.length)).length > 0
  } catch {
    return false
  }
}

function isSnapshotIndexEligible(record: HostSessionLaunchRecord): boolean {
  const snapshot = record.launchSnapshot
  const providerSession = normalizeAgentProviderSession(record.providerSession)
  return Boolean(
    typeof record.worktreeId === 'string' &&
    record.worktreeId.length > 0 &&
    isTuiAgent(record.requestedAgent) &&
    isResumableTuiAgent(record.baseAgent) &&
    providerSession &&
    providerSession.key === providerSessionKeyForResumableBase(record.baseAgent) &&
    snapshot &&
    snapshot.version === 1 &&
    isTuiAgent(snapshot.requestedAgent) &&
    snapshot.baseAgent === record.baseAgent &&
    typeof snapshot.displayLabel === 'string' &&
    SNAPSHOT_MODES.has(snapshot.mode) &&
    Array.isArray(snapshot.argv) &&
    snapshot.argv.length > 0 &&
    snapshot.argv.every((value) => typeof value === 'string') &&
    snapshot.argv[0].length > 0 &&
    isStringRecord(snapshot.agentEnv) &&
    CAPTURED_ENV_POLICIES.has(snapshot.capturedEnvPolicy) &&
    snapshot.target &&
    isExecutionHostId(snapshot.target.executionHostId) &&
    typeof snapshot.target.executionHostId === 'string' &&
    NODE_PLATFORMS.has(snapshot.target.platform) &&
    (snapshot.target.execution === 'native' || snapshot.target.execution === 'wsl') &&
    STARTUP_SHELLS.has(snapshot.target.shell) &&
    typeof snapshot.target.isRemote === 'boolean'
  )
}

function providerIndexKey(
  targetExecutionHostId: AgentLaunchExecutionHostId,
  baseAgent: ResumableTuiAgent,
  providerSessionId: string
): string {
  return `${targetExecutionHostId}\0${baseAgent}\0${providerSessionId}`
}

function transcriptIndexKey(
  targetExecutionHostId: AgentLaunchExecutionHostId,
  baseAgent: ResumableTuiAgent,
  transcriptIdentity: string
): string {
  return `${targetExecutionHostId}\0${baseAgent}\0${transcriptIdentity}`
}

/** Derived, in-memory-only indexes for Vault-to-private-record correlation. */
export class AgentSessionVaultSnapshotIndex {
  private readonly ownershipByProvider = new Map<string, Set<string>>()
  private readonly ownershipByTranscript = new Map<string, Set<string>>()
  private readonly targetIndex = new AgentSessionVaultTargetIndex()

  clear(): void {
    this.ownershipByProvider.clear()
    this.ownershipByTranscript.clear()
    this.targetIndex.clear()
  }

  add(ownershipKey: string, record: HostSessionLaunchRecord): void {
    if (!isSnapshotIndexEligible(record) || !record.launchSnapshot) {
      return
    }
    const target = record.launchSnapshot.target
    this.targetIndex.add(record.baseAgent, target)
    this.addIndexValue(
      this.ownershipByProvider,
      providerIndexKey(target.executionHostId, record.baseAgent, record.providerSession.id),
      ownershipKey
    )
    const transcriptIdentity = this.recordTranscriptIdentity(record)
    if (transcriptIdentity) {
      this.addIndexValue(
        this.ownershipByTranscript,
        transcriptIndexKey(target.executionHostId, record.baseAgent, transcriptIdentity),
        ownershipKey
      )
    }
  }

  remove(ownershipKey: string, record: HostSessionLaunchRecord): void {
    if (!isSnapshotIndexEligible(record) || !record.launchSnapshot) {
      return
    }
    const target = record.launchSnapshot.target
    this.targetIndex.remove(record.baseAgent, target)
    this.deleteIndexValue(
      this.ownershipByProvider,
      providerIndexKey(target.executionHostId, record.baseAgent, record.providerSession.id),
      ownershipKey
    )
    const transcriptIdentity = this.recordTranscriptIdentity(record)
    if (transcriptIdentity) {
      this.deleteIndexValue(
        this.ownershipByTranscript,
        transcriptIndexKey(target.executionHostId, record.baseAgent, transcriptIdentity),
        ownershipKey
      )
    }
  }

  resolve(
    args: {
      baseAgent: ResumableTuiAgent
      scannedProviderSessionId: string
      scannedTranscriptPath?: string | null
      targetExecutionHostId: AgentLaunchExecutionHostId
      targetPlatform: NodeJS.Platform
      preferredWorktreeId?: string | null
    },
    records: ReadonlyMap<string, HostSessionLaunchRecord>
  ): VaultSnapshotOwnerResolution {
    if (
      args.scannedTranscriptPath &&
      transcriptPathConflictsWithWslTarget(args.scannedTranscriptPath, args.targetExecutionHostId)
    ) {
      return { kind: 'missing' }
    }
    const transcriptIdentity = args.scannedTranscriptPath
      ? canonicalAgentSessionTranscriptIdentity({
          transcriptPath: args.scannedTranscriptPath,
          targetExecutionHostId: args.targetExecutionHostId,
          targetPlatform: args.targetPlatform
        })
      : null
    const pathCandidates = transcriptIdentity
      ? this.ownershipByTranscript.get(
          transcriptIndexKey(args.targetExecutionHostId, args.baseAgent, transcriptIdentity)
        )
      : undefined
    if (pathCandidates && pathCandidates.size > 0) {
      return this.selectOwner(pathCandidates, args.preferredWorktreeId, records)
    }

    const idCandidates = this.ownershipByProvider.get(
      providerIndexKey(args.targetExecutionHostId, args.baseAgent, args.scannedProviderSessionId)
    )
    if (!idCandidates || idCandidates.size === 0) {
      return { kind: 'missing' }
    }
    const survivors = new Set<string>()
    for (const ownershipKey of idCandidates) {
      const record = records.get(ownershipKey)
      if (!record?.launchSnapshot || !isSnapshotIndexEligible(record)) {
        continue
      }
      const recordIdentity = this.recordTranscriptIdentity(record)
      // A known different transcript proves a repeated provider id is not this row.
      if (transcriptIdentity && recordIdentity && transcriptIdentity !== recordIdentity) {
        continue
      }
      survivors.add(ownershipKey)
    }
    return this.selectOwner(survivors, args.preferredWorktreeId, records)
  }

  /** Resolve display-only snapshot data without accepting a client-authored
   * target. A local Vault scan may represent either native or WSL storage. */
  resolveForDiscoveredHost(
    args: VaultSnapshotScanIdentity,
    records: ReadonlyMap<string, HostSessionLaunchRecord>
  ): VaultSnapshotOwnerResolution {
    const targets = this.targetIndex.matching(args.baseAgent, args.scannedExecutionHostId)
    if (targets.length === 0) {
      return { kind: 'missing' }
    }
    const found = new Map<string, AgentSessionOwnershipKey>()
    for (const target of targets) {
      const resolution = this.resolve(
        {
          baseAgent: args.baseAgent,
          scannedProviderSessionId: args.scannedProviderSessionId,
          scannedTranscriptPath: args.scannedTranscriptPath,
          targetExecutionHostId: target.executionHostId,
          targetPlatform: target.platform
        },
        records
      )
      if (resolution.kind === 'ambiguous') {
        return resolution
      }
      if (resolution.kind === 'found') {
        found.set(JSON.stringify(resolution.sessionKey), resolution.sessionKey)
      }
    }
    if (found.size === 1) {
      return { kind: 'found', sessionKey: [...found.values()][0] }
    }
    return found.size === 0 ? { kind: 'missing' } : { kind: 'ambiguous' }
  }

  private recordTranscriptIdentity(record: HostSessionLaunchRecord): string | null {
    const snapshot = record.launchSnapshot
    const transcriptPath = record.providerSession.transcriptPath
    return snapshot && transcriptPath
      ? canonicalAgentSessionTranscriptIdentity({
          transcriptPath,
          targetExecutionHostId: snapshot.target.executionHostId,
          targetPlatform: snapshot.target.platform
        })
      : null
  }

  private selectOwner(
    ownershipKeys: ReadonlySet<string>,
    preferredWorktreeId: string | null | undefined,
    records: ReadonlyMap<string, HostSessionLaunchRecord>
  ): VaultSnapshotOwnerResolution {
    const candidates = [...ownershipKeys].flatMap((ownershipKey) => {
      const record = records.get(ownershipKey)
      return record && isSnapshotIndexEligible(record) ? [record] : []
    })
    if (preferredWorktreeId) {
      const preferred = candidates.filter((record) => record.worktreeId === preferredWorktreeId)
      if (preferred.length === 1) {
        return { kind: 'found', sessionKey: vaultSessionKeyForRecord(preferred[0]) }
      }
      if (preferred.length > 1) {
        return { kind: 'ambiguous' }
      }
    }
    if (candidates.length === 1) {
      return { kind: 'found', sessionKey: vaultSessionKeyForRecord(candidates[0]) }
    }
    return candidates.length === 0 ? { kind: 'missing' } : { kind: 'ambiguous' }
  }

  private addIndexValue(index: Map<string, Set<string>>, key: string, ownershipKey: string): void {
    const values = index.get(key) ?? new Set<string>()
    values.add(ownershipKey)
    index.set(key, values)
  }

  private deleteIndexValue(
    index: Map<string, Set<string>>,
    key: string,
    ownershipKey: string
  ): void {
    const values = index.get(key)
    if (!values) {
      return
    }
    values.delete(ownershipKey)
    if (values.size === 0) {
      index.delete(key)
    }
  }
}
