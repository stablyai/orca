import {
  sameTerminalOutputSourceIdentity,
  type TerminalOutputSourceRange
} from '../../shared/terminal-output-source-range'
import type {
  RemoteTerminalSourceRangeConsumerHooks,
  RemoteTerminalSourceRangeStreamIdentity
} from '../runtime/remote-terminal-source-range-consumer'
import type { PtySourceSpan } from '../../shared/pty-source-credit-contract'
import type { SshPtySourceConsumerId } from './ssh-pty-source-obligation-contract'
import type { SshPtySourceObligationCoordinator } from './ssh-pty-source-obligation-coordinator'
import { SshPtyRemoteSourceRangeReplacements } from './ssh-pty-remote-source-range-replacement'

function remoteConsumerId(
  identity: RemoteTerminalSourceRangeStreamIdentity
): SshPtySourceConsumerId {
  return `remote:${identity.consumerId}`
}

function uniqueSpanIds(ranges: readonly TerminalOutputSourceRange[]): string[] {
  return Array.from(new Set(ranges.map((range) => range.spanId)))
}

type RemoteConsumerState = {
  streamGeneration: string
  spans: Map<
    string,
    Readonly<{
      identity: PtySourceSpan
      modelSequenceEnd: number
    }>
  >
  ackedEndBySpan: Map<string, number>
}

export class SshPtyRemoteSourceRangeConsumers {
  private readonly consumersByPty = new Map<string, Map<string, RemoteConsumerState>>()
  private readonly replacements: SshPtyRemoteSourceRangeReplacements

  constructor(
    private readonly coordinator: SshPtySourceObligationCoordinator,
    private readonly onProgress: (range: TerminalOutputSourceRange) => void = () => {}
  ) {
    this.replacements = new SshPtyRemoteSourceRangeReplacements(coordinator)
  }

  readonly hooks: RemoteTerminalSourceRangeConsumerHooks = {
    attach: (identity) => this.attach(identity),
    settle: (identity, ranges) => this.settle(identity, ranges),
    reserveReplacement: (identity, requiredSeq, reason) =>
      this.reserveReplacement(identity, requiredSeq, reason),
    commitReplacement: (reservation, publication) =>
      this.commitReplacement(reservation, publication),
    rollbackReplacement: (reservation, reason) => this.rollbackReplacement(reservation, reason),
    cancel: (identity, ranges, reason) => this.cancel(identity, ranges, reason)
  }

  requiredConsumers(ptyId: string): readonly SshPtySourceConsumerId[] {
    return Object.freeze(
      Array.from(this.consumersByPty.get(ptyId)?.keys() ?? []).map(
        (consumerId) => `remote:${consumerId}` as const
      )
    )
  }

  trackSpan(
    ptyId: string,
    spanId: string,
    requiredConsumers: readonly SshPtySourceConsumerId[],
    modelSequenceEnd: number
  ): void {
    if (!Number.isSafeInteger(modelSequenceEnd) || modelSequenceEnd < 0) {
      throw new Error('ssh_remote_source_range_model_sequence_invalid')
    }
    for (const [consumerId, state] of this.consumersByPty.get(ptyId) ?? []) {
      if (requiredConsumers.includes(`remote:${consumerId}`)) {
        state.spans.set(
          spanId,
          Object.freeze({
            identity: this.coordinator.spanIdentity(spanId),
            modelSequenceEnd
          })
        )
      }
    }
  }

  closeGeneration(providerGeneration: number, reason: string): void {
    this.replacements.closeGeneration(providerGeneration, reason)
    for (const consumers of this.consumersByPty.values()) {
      for (const state of consumers.values()) {
        for (const [spanId, tracked] of state.spans) {
          if (tracked.identity.providerGeneration === providerGeneration) {
            state.spans.delete(spanId)
            state.ackedEndBySpan.delete(spanId)
          }
        }
      }
    }
  }

  private attach(identity: RemoteTerminalSourceRangeStreamIdentity): boolean {
    const consumers =
      this.consumersByPty.get(identity.ptyId) ?? new Map<string, RemoteConsumerState>()
    const current = consumers.get(identity.consumerId)
    if (current && current.streamGeneration !== identity.streamGeneration) {
      return false
    }
    consumers.set(
      identity.consumerId,
      current ?? {
        streamGeneration: identity.streamGeneration,
        spans: new Map(),
        ackedEndBySpan: new Map()
      }
    )
    this.consumersByPty.set(identity.ptyId, consumers)
    return true
  }

  private settle(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[]
  ): void {
    if (!this.isCurrent(identity)) {
      return
    }
    const state = this.requireState(identity)
    const consumer = remoteConsumerId(identity)
    const nextEnds = new Map(state.ackedEndBySpan)
    const completed = new Set<string>()
    for (const range of ranges) {
      const tracked = state.spans.get(range.spanId)
      if (!tracked) {
        continue
      }
      const source = tracked.identity
      if (!this.coordinator.hasRetainedSpan(range.spanId)) {
        state.spans.delete(range.spanId)
        nextEnds.delete(range.spanId)
        continue
      }
      const currentEnd = nextEnds.get(range.spanId) ?? source.sourceStartSu
      if (
        !sameTerminalOutputSourceIdentity(source, range) ||
        range.sourceStartSu !== currentEnd ||
        range.sourceEndSu > source.sourceEndSu
      ) {
        throw new Error('ssh_remote_source_range_settlement_invalid')
      }
      nextEnds.set(range.spanId, range.sourceEndSu)
      if (range.sourceEndSu === source.sourceEndSu) {
        completed.add(range.spanId)
      }
    }
    state.ackedEndBySpan = nextEnds
    for (const spanId of completed) {
      const tracked = state.spans.get(spanId)
      if (!tracked || !this.coordinator.hasRetainedSpan(spanId)) {
        state.spans.delete(spanId)
        state.ackedEndBySpan.delete(spanId)
        continue
      }
      const source = tracked.identity
      this.coordinator.settle({
        identity: source,
        spanId,
        consumer,
        reason: 'remote-frame-ack'
      })
      state.spans.delete(spanId)
      state.ackedEndBySpan.delete(spanId)
    }
    for (const range of ranges) {
      this.onProgress(range)
    }
  }

  private reserveReplacement(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    requiredSeq: number,
    reason: string
  ): ReturnType<SshPtyRemoteSourceRangeReplacements['reserve']> {
    if (!this.isCurrent(identity)) {
      throw new Error('ssh_remote_source_range_stale_generation')
    }
    const state = this.requireState(identity)
    for (const spanId of state.spans.keys()) {
      if (!this.coordinator.hasRetainedSpan(spanId)) {
        state.spans.delete(spanId)
        state.ackedEndBySpan.delete(spanId)
      }
    }
    const spanIds = Array.from(state.spans)
      .filter(([, tracked]) => tracked.modelSequenceEnd <= requiredSeq)
      .map(([spanId]) => spanId)
    return this.replacements.reserve(identity, spanIds, requiredSeq, reason)
  }

  private commitReplacement(
    reservation: Parameters<SshPtyRemoteSourceRangeReplacements['commit']>[0],
    publication: Parameters<SshPtyRemoteSourceRangeReplacements['commit']>[1]
  ): boolean {
    return this.replacements.commit(
      reservation,
      publication,
      this.isCurrent(reservation.identity),
      (spanIds) => {
        const state = this.requireState(reservation.identity)
        for (const spanId of spanIds) {
          state.spans.delete(spanId)
          state.ackedEndBySpan.delete(spanId)
        }
      }
    )
  }

  private rollbackReplacement(
    reservation: Parameters<SshPtyRemoteSourceRangeReplacements['rollback']>[0],
    reason: string
  ): boolean {
    return this.replacements.rollback(reservation, reason)
  }

  private cancel(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[],
    reason: string
  ): void {
    if (!this.isCurrent(identity)) {
      return
    }
    this.replacements.rollbackIdentity(identity, `${reason}-replacement-aborted`)
    const consumer = remoteConsumerId(identity)
    const state = this.requireState(identity)
    const spanIds = new Set([
      ...state.spans.keys(),
      ...uniqueSpanIds(ranges).filter((spanId) => state.spans.has(spanId))
    ])
    for (const spanId of spanIds) {
      const tracked = state.spans.get(spanId)
      if (!tracked || !this.coordinator.hasRetainedSpan(spanId)) {
        continue
      }
      const source = tracked.identity
      const transition = { identity: source, spanId, consumer, reason }
      if (this.coordinator.beginTransfer(transition, consumer)) {
        this.coordinator.cancelTransfer(transition)
      }
    }
    this.detachIdentity(identity)
    for (const range of ranges) {
      this.onProgress(range)
    }
  }

  private isCurrent(identity: RemoteTerminalSourceRangeStreamIdentity): boolean {
    return (
      this.consumersByPty.get(identity.ptyId)?.get(identity.consumerId)?.streamGeneration ===
      identity.streamGeneration
    )
  }

  private requireState(identity: RemoteTerminalSourceRangeStreamIdentity): RemoteConsumerState {
    const state = this.consumersByPty.get(identity.ptyId)?.get(identity.consumerId)
    if (!state || state.streamGeneration !== identity.streamGeneration) {
      throw new Error('ssh_remote_source_range_stale_generation')
    }
    return state
  }

  private detachIdentity(identity: RemoteTerminalSourceRangeStreamIdentity): void {
    const consumers = this.consumersByPty.get(identity.ptyId)
    if (
      !consumers ||
      consumers.get(identity.consumerId)?.streamGeneration !== identity.streamGeneration
    ) {
      return
    }
    consumers.delete(identity.consumerId)
    if (consumers.size === 0) {
      this.consumersByPty.delete(identity.ptyId)
    }
  }
}
