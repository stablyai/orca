import { PTY_VISIBLE_SCREEN_SNAPSHOT_PROTOCOL_VERSION } from '../../shared/pty-visible-screen-snapshot'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'
import type { PtyProviderBufferSnapshot } from './types'

export class SshPtyVisibleScreenSnapshots {
  private capabilityProbe: Promise<boolean> | null = null
  private supported = false

  constructor(
    private readonly mux: SshChannelMultiplexer,
    private readonly toRelayPtyId: (id: string) => string,
    private readonly readIncarnation: (relayPtyId: string) => string | undefined
  ) {}

  canProvide(): boolean {
    return this.supported
  }

  async probe(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const probe = this.capabilityProbe ?? this.probeCapability()
    this.capabilityProbe = probe
    try {
      const supported = await waitForSshCapabilityProbe(probe, options.signal)
      this.supported = supported
      if (!supported && this.capabilityProbe === probe) {
        this.capabilityProbe = null
      }
      return supported
    } catch {
      return false
    }
  }

  async get(
    id: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    if (!this.supported) {
      return null
    }
    const relayPtyId = this.toRelayPtyId(id)
    const expectedIncarnation = this.readIncarnation(relayPtyId)
    if (!expectedIncarnation) {
      return null
    }
    const result = await this.mux.request('pty.getBufferSnapshot', {
      id: relayPtyId,
      scrollbackRows: opts.scrollbackRows ?? 0
    })
    return isSshPtyBufferSnapshot(result, expectedIncarnation) ? result : null
  }

  private async probeCapability(): Promise<boolean> {
    try {
      const result = (await this.mux.request('pty.getCapabilities', undefined, {
        timeoutMs: 5_000
      })) as { visibleScreenSnapshotVersion?: unknown }
      return result.visibleScreenSnapshotVersion === PTY_VISIBLE_SCREEN_SNAPSHOT_PROTOCOL_VERSION
    } catch {
      return false
    }
  }
}

function isSshPtyBufferSnapshot(
  value: unknown,
  expectedIncarnation: string
): value is PtyProviderBufferSnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }
  const snapshot = value as Partial<PtyProviderBufferSnapshot>
  return (
    snapshot.incarnationId === expectedIncarnation &&
    typeof snapshot.data === 'string' &&
    Number.isInteger(snapshot.cols) &&
    Number(snapshot.cols) > 0 &&
    Number.isInteger(snapshot.rows) &&
    Number(snapshot.rows) > 0 &&
    Number.isSafeInteger(snapshot.seq) &&
    Number(snapshot.seq) >= 0 &&
    snapshot.source === 'headless'
  )
}
