import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  normalizeRelayPtyReviveOutcome,
  type PtyReviveResult,
  type RelayPtyReviveOutcomeV1
} from '../../shared/pty-revive-protocol'
import { SshPtyReviveCapabilities } from './ssh-pty-revive-capabilities'
import { isAdmittedSshRelayPtyId } from './ssh-pty-wire-admission'
import type { PtyPersistenceProtocolOptions } from './types'

export class SshPtyPersistenceRevive {
  private readonly capabilities: SshPtyReviveCapabilities

  constructor(
    private readonly mux: SshChannelMultiplexer,
    private readonly toRelayPtyId: (id: string) => string,
    private readonly toAppPtyId: (id: string) => string
  ) {
    this.capabilities = new SshPtyReviveCapabilities(mux)
  }

  async serialize(ids: string[], options?: PtyPersistenceProtocolOptions): Promise<string> {
    const supportsTypedRevive =
      options?.formatVersion === 2 && (await this.capabilities.supportsTypedRevive())
    const result = await this.mux.request('pty.serialize', {
      ids: ids.map((id) => this.toRelayPtyId(id)),
      ...(supportsTypedRevive ? { formatVersion: 2 } : {})
    })
    return result as string
  }

  async revive(state: string, options?: PtyPersistenceProtocolOptions): Promise<PtyReviveResult> {
    const supportsTypedRevive =
      options?.formatVersion === 2 && (await this.capabilities.supportsTypedRevive())
    if (!supportsTypedRevive) {
      await this.mux.request('pty.revive', { state })
      return { mode: 'legacy', diagnosticCode: 'pty-revive-outcome-unavailable' }
    }
    const result = await this.mux.request('pty.revive', { state, formatVersion: 2 })
    return {
      mode: 'typed',
      outcome: this.mapTypedReviveOutcome(normalizeRelayPtyReviveOutcome(result))
    }
  }

  private mapTypedReviveOutcome(outcome: RelayPtyReviveOutcomeV1): RelayPtyReviveOutcomeV1 {
    for (const entry of [...outcome.revived, ...outcome.lost]) {
      if (!isAdmittedSshRelayPtyId(entry.id)) {
        throw new Error('PTY revive outcome contains an invalid relay PTY id')
      }
    }
    for (const entry of outcome.lost) {
      for (const owner of entry.agentOwners ?? []) {
        if (!isAdmittedSshRelayPtyId(owner.ptyId) || owner.ptyId !== entry.id) {
          throw new Error('PTY revive outcome contains an invalid agent owner PTY id')
        }
      }
    }
    for (const diagnostic of outcome.diagnostics) {
      if (diagnostic.id !== undefined && !isAdmittedSshRelayPtyId(diagnostic.id)) {
        throw new Error('PTY revive outcome contains an invalid relay PTY id')
      }
    }
    return {
      ...outcome,
      revived: outcome.revived.map((entry) => ({ ...entry, id: this.toAppPtyId(entry.id) })),
      lost: outcome.lost.map((entry) => ({
        ...entry,
        id: this.toAppPtyId(entry.id),
        ...(entry.agentOwners
          ? {
              agentOwners: entry.agentOwners.map((owner) => ({
                ...owner,
                ptyId: this.toAppPtyId(owner.ptyId)
              }))
            }
          : {})
      })),
      diagnostics: outcome.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        ...(diagnostic.id === undefined ? {} : { id: this.toAppPtyId(diagnostic.id) })
      }))
    }
  }
}
