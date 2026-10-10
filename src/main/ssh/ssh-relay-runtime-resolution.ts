/**
 * One pass down the relay runtime ladder (design D6): what it learned about the host, the
 * decision it persists per host, the telemetry it sends, and the rung D failure it raises.
 */
import { getAppEnvironment } from '../../shared/app-environment'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
import type {
  SshRemoteRuntimeResolution,
  SshRemoteRuntimeRung,
  SshTarget
} from '../../shared/ssh-types'
import type { TerminalUnavailableCause } from '../../shared/terminal-unavailable-cause'
import type { OrcadDeploymentTargetFacts } from './orcad-deployment-target'
import { isPinnedRuntimeRefusal, type RelayRuntimeFallbackReason } from './ssh-relay-pinned-node'
import {
  forgetPinnedRuntimeRefusal,
  isPinnedRefusalExpired
} from './ssh-relay-pinned-refusal-cache'
import {
  remoteRuntimeUnavailable,
  type RelayRuntimeStep,
  type RemoteRuntimeUnavailableReason
} from './ssh-relay-runtime-ladder'
import type { PinnedRuntimeRefusal } from './ssh-relay-runtime-self-test'
import { rememberSshHostPlatform } from './ssh-host-platform-memo'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import type { HostNodeVersion } from './ssh-remote-node-toolchain-probe'
import {
  trackSshRemoteRuntimeResolved,
  type SshRemoteRuntimeOutcome
} from './ssh-remote-runtime-telemetry'

export type RelayRuntimeSelfTestOutcome =
  | 'passed'
  | 'refused'
  | 'failed'
  | 'unverifiable'
  | 'not_run'
export type RelayRuntimeTransfer = 'uploaded' | 'cached' | 'none'

export type RelayRuntimeDecisionStore = {
  read: (targetId: string) => SshRemoteRuntimeResolution | undefined
  write: (targetId: string, resolution: SshRemoteRuntimeResolution) => void
}

type DecisionKey = Pick<SshRemoteRuntimeResolution, 'glibc' | 'runtimeSha256' | 'orcaMajor'>

export function relayRuntimeDecisionKey(facts: OrcadDeploymentTargetFacts): DecisionKey {
  return {
    glibc: facts.glibc ? `${facts.glibc.major}.${facts.glibc.minor}` : null,
    runtimeSha256: NODE_RUNTIME_ASSETS[facts.target].executableSha256,
    orcaMajor: orcaMajorVersion()
  }
}

function orcaMajorVersion(): number {
  const major = Number.parseInt(getAppEnvironment().getVersion().split('.')[0] ?? '', 10)
  return Number.isFinite(major) ? major : 0
}

function sameKey(a: DecisionKey, b: DecisionKey): boolean {
  return a.glibc === b.glibc && a.runtimeSha256 === b.runtimeSha256 && a.orcaMajor === b.orcaMajor
}

/** The persisted rung A refusal, only while its key still describes this host and build. */
export function persistedPinnedRefusal(
  decision: SshRemoteRuntimeResolution | undefined,
  facts: OrcadDeploymentTargetFacts
): PinnedRuntimeRefusal | null {
  if (!decision?.pinnedRefusal || !sameKey(decision, relayRuntimeDecisionKey(facts))) {
    return null
  }
  const refusal = decision.pinnedRefusal
  return isPinnedRuntimeRefusal(refusal) &&
    !isPinnedRefusalExpired(refusal, facts.target, decision.refusedAt)
    ? refusal
    : null
}

export class RelayRuntimeLadderRun {
  readonly startedAt = Date.now()
  host: RemoteHostPlatform | null = null
  facts: OrcadDeploymentTargetFacts | null = null
  firstRefusal: RelayRuntimeFallbackReason | null = null
  lastRefusal: RelayRuntimeFallbackReason | null = null
  pinnedRefusal: PinnedRuntimeRefusal | null = null
  /** The pinned refusal was replayed from a cache rather than proved on this pass. */
  pinnedRefusalRemembered = false
  /** A noexec this pass replayed from a cache, else proved; a replay is never downgraded. */
  noexec: 'remembered' | 'proved' | null = null
  /** A rung refused because this client lacked Orca's artifacts; nothing it proves is the host's. */
  clientArtifactGap = false
  /** The Node the fallback's strict probe found, reused by the launch. */
  hostNodePath: string | null = null
  /** This step issued its relay launch; failures after it never step down. */
  launchStarted = false
  selfTest: RelayRuntimeSelfTestOutcome = 'not_run'
  runtimeTransfer: RelayRuntimeTransfer = 'none'
  hostNode: HostNodeVersion | null = null

  constructor(
    readonly targetId: string,
    private readonly store: RelayRuntimeDecisionStore | null,
    /** A laddered legacy step is the host-Node fallback, so a host with no Node lands on D. */
    readonly laddered: boolean
  ) {}

  persistedPinnedRefusal(facts: OrcadDeploymentTargetFacts): PinnedRuntimeRefusal | null {
    return this.store ? persistedPinnedRefusal(this.store.read(this.targetId), facts) : null
  }

  refused(step: RelayRuntimeStep, reason: RelayRuntimeFallbackReason, remembered = false): void {
    this.firstRefusal ??= reason
    this.lastRefusal = reason
    if (reason === 'artifacts_unavailable') {
      this.clientArtifactGap = true
    }
    if (reason === 'noexec') {
      this.noexec = remembered ? 'remembered' : (this.noexec ?? 'proved')
    }
    if (step === 'A' && isPinnedRuntimeRefusal(reason)) {
      this.pinnedRefusal = reason
      this.pinnedRefusalRemembered = remembered
    }
  }

  /** Each rung reports its own self-test; a rung D report keeps the one that refused. */
  enter(step: RelayRuntimeStep): void {
    if (step !== 'D') {
      this.selfTest = 'not_run'
    }
  }

  settle(rung: SshRemoteRuntimeRung): void {
    // Why: C's self-test loaded addons from the same tree, which disproves a remembered noexec.
    // Why also at D on a replayed noexec: nothing connects there, so the next connect re-proves A
    // instead of the message's "allow exec" advice being unfixable.
    const disproved = rung === 'C' && this.selfTest === 'passed'
    const replayedAtD = rung === 'D' && this.noexec === 'remembered'
    if ((disproved || replayedAtD) && this.pinnedRefusal === 'noexec') {
      this.pinnedRefusal = null
      if (this.facts) {
        forgetPinnedRuntimeRefusal(this.targetId, this.facts.target)
      }
    }
    // Why: a pass shaped by this client's missing artifacts is no decision about the host.
    if (!this.clientArtifactGap) {
      this.persist(rung)
    }
    this.track(rung, 'resolved')
  }

  /** A rung whose self-test was unverifiable or failed: nothing settles, but the attempt counts. */
  unresolved(step: RelayRuntimeStep): void {
    if (step === 'D' || step === 'legacy') {
      return
    }
    if (this.selfTest === 'unverifiable' || this.selfTest === 'failed') {
      this.track(step, this.selfTest)
    }
  }

  private track(rung: SshRemoteRuntimeRung, outcome: SshRemoteRuntimeOutcome): void {
    if (this.host) {
      rememberSshHostPlatform(this.targetId, this.host, this.facts?.target ?? null)
      trackSshRemoteRuntimeResolved(this.targetId, {
        rung,
        outcome,
        host: this.host,
        facts: this.facts,
        firstRefusal: this.firstRefusal,
        selfTest: this.selfTest,
        runtimeTransfer: this.runtimeTransfer,
        hostNode: rung === 'C' ? this.hostNode : null,
        durationMs: Date.now() - this.startedAt
      })
    }
  }

  private persist(rung: SshRemoteRuntimeRung): void {
    // Why facts-gated: the key names the host's glibc; without an answered probe there is none.
    if (!this.store || !this.facts) {
      return
    }
    const previous = this.store.read(this.targetId)
    // Why keep the earlier time on a replay: a replayed refusal must still expire on schedule.
    const refusedAt =
      this.pinnedRefusalRemembered && previous?.pinnedRefusal === this.pinnedRefusal
        ? (previous.refusedAt ?? Date.now())
        : Date.now()
    const next: SshRemoteRuntimeResolution = {
      rung,
      ...(this.pinnedRefusal ? { pinnedRefusal: this.pinnedRefusal } : {}),
      ...(this.pinnedRefusal ? { refusedAt } : {}),
      ...relayRuntimeDecisionKey(this.facts)
    }
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      try {
        this.store.write(this.targetId, next)
      } catch (error) {
        // A lost cache costs one more rung A attempt on the next connect, never the connect.
        console.warn('[ssh-relay] Could not persist the relay runtime decision:', error)
      }
    }
  }
}

/** Rung D: no runtime runs on this host. Carries the classified cause for structured readers. */
export class RemoteRuntimeUnavailableError extends Error {
  readonly reason: RemoteRuntimeUnavailableReason
  readonly data: TerminalUnavailableCause

  constructor(run: RelayRuntimeLadderRun) {
    const { reason, message } = remoteRuntimeUnavailable({
      firstRefusal: run.firstRefusal,
      hostNodeRefusal: run.lastRefusal,
      noexec: run.noexec,
      hostOs: run.host?.os ?? null
    })
    super(message)
    this.name = 'RemoteRuntimeUnavailableError'
    this.reason = reason
    const glibc = run.facts?.glibc
    this.data = {
      status: 'blocked',
      reason,
      detail: `last refusal: ${run.lastRefusal ?? 'none'}`,
      repairable: false,
      host: {
        platform: run.host?.os ?? 'unknown',
        arch: run.host?.arch ?? 'unknown',
        libc: run.facts?.target.endsWith('-musl')
          ? 'musl'
          : run.facts?.target.endsWith('-glibc')
            ? 'glibc'
            : 'none',
        ...(glibc ? { glibcVersion: `${glibc.major}.${glibc.minor}` } : {}),
        nodeAbi: 'none',
        nodeVersion: 'none'
      }
    }
  }
}

export function sshTargetRelayRuntimeDecisionStore(registry: {
  getTarget: (id: string) => SshTarget | undefined
  updateTarget: (id: string, updates: Partial<Omit<SshTarget, 'id'>>) => unknown
}): RelayRuntimeDecisionStore {
  return {
    read: (targetId) => registry.getTarget(targetId)?.remoteRuntimeResolution,
    write: (targetId, resolution) => {
      registry.updateTarget(targetId, { remoteRuntimeResolution: resolution })
    }
  }
}
