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
import {
  forgetPinnedRuntimeRefusal,
  isPinnedRuntimeRefusal,
  type RelayRuntimeFallbackReason
} from './ssh-relay-pinned-node'
import {
  remoteRuntimeUnavailableMessage,
  remoteRuntimeUnavailableReason,
  type RelayRuntimeStep,
  type RemoteRuntimeUnavailableReason
} from './ssh-relay-runtime-ladder'
import type { PinnedRuntimeRefusal } from './ssh-relay-runtime-self-test'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import type { HostNodeVersion } from './ssh-remote-node-toolchain-probe'
import { trackSshRemoteRuntimeResolved } from './ssh-remote-runtime-telemetry'

export type RelayRuntimeSelfTestOutcome = 'passed' | 'refused' | 'failed' | 'not_run'
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
  return isPinnedRuntimeRefusal(decision.pinnedRefusal) ? decision.pinnedRefusal : null
}

export class RelayRuntimeLadderRun {
  readonly startedAt = Date.now()
  host: RemoteHostPlatform | null = null
  facts: OrcadDeploymentTargetFacts | null = null
  firstRefusal: RelayRuntimeFallbackReason | null = null
  lastRefusal: RelayRuntimeFallbackReason | null = null
  pinnedRefusal: PinnedRuntimeRefusal | null = null
  /** A noexec this pass replayed from a cache rather than proved. */
  noexecRemembered = false
  selfTest: RelayRuntimeSelfTestOutcome = 'not_run'
  runtimeTransfer: RelayRuntimeTransfer = 'none'
  hostNode: HostNodeVersion | null = null

  constructor(
    readonly targetId: string,
    private readonly store: RelayRuntimeDecisionStore | null
  ) {}

  persistedPinnedRefusal(facts: OrcadDeploymentTargetFacts): PinnedRuntimeRefusal | null {
    return this.store ? persistedPinnedRefusal(this.store.read(this.targetId), facts) : null
  }

  refused(step: RelayRuntimeStep, reason: RelayRuntimeFallbackReason, remembered = false): void {
    this.firstRefusal ??= reason
    this.lastRefusal = reason
    if (reason === 'noexec' && remembered) {
      this.noexecRemembered = true
    }
    if (step === 'A' && isPinnedRuntimeRefusal(reason)) {
      this.pinnedRefusal = reason
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
    const replayedAtD = rung === 'D' && this.noexecRemembered
    if ((disproved || replayedAtD) && this.pinnedRefusal === 'noexec') {
      this.pinnedRefusal = null
      if (this.facts) {
        forgetPinnedRuntimeRefusal(this.targetId, this.facts.target)
      }
    }
    this.persist(rung)
    if (this.host) {
      trackSshRemoteRuntimeResolved(this.targetId, {
        rung,
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
    const next: SshRemoteRuntimeResolution = {
      rung,
      ...(this.pinnedRefusal ? { pinnedRefusal: this.pinnedRefusal } : {}),
      ...relayRuntimeDecisionKey(this.facts)
    }
    const previous = this.store.read(this.targetId)
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
  readonly data: TerminalUnavailableCause

  constructor(
    readonly reason: RemoteRuntimeUnavailableReason,
    run: RelayRuntimeLadderRun
  ) {
    super(remoteRuntimeUnavailableMessage(reason, run.firstRefusal, run.noexecRemembered))
    this.name = 'RemoteRuntimeUnavailableError'
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

export function remoteRuntimeUnavailableError(run: RelayRuntimeLadderRun): Error {
  return new RemoteRuntimeUnavailableError(
    remoteRuntimeUnavailableReason(run.lastRefusal, run.noexecRemembered),
    run
  )
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
