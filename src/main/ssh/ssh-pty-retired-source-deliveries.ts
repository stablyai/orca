import type { SshPtySourceFrame } from '../providers/ssh-pty-source-frame'

type SourceDeliveryIdentity = Pick<
  SshPtySourceFrame,
  'relayPtyId' | 'deliveryToken' | 'clientGeneration' | 'ownerGeneration'
>

export class SshPtyRetiredSourceDeliveries {
  private readonly keyByRelayPtyId = new Map<string, string>()

  has(providerGeneration: number, source: SourceDeliveryIdentity): boolean {
    return (
      this.keyByRelayPtyId.get(source.relayPtyId) === sourceDeliveryKey(providerGeneration, source)
    )
  }

  retire(providerGeneration: number, source: SourceDeliveryIdentity): void {
    this.keyByRelayPtyId.set(source.relayPtyId, sourceDeliveryKey(providerGeneration, source))
  }

  activate(relayPtyId: string): void {
    this.keyByRelayPtyId.delete(relayPtyId)
  }

  clear(): void {
    this.keyByRelayPtyId.clear()
  }

  get size(): number {
    return this.keyByRelayPtyId.size
  }
}

function sourceDeliveryKey(providerGeneration: number, source: SourceDeliveryIdentity): string {
  return `${providerGeneration}\0${source.clientGeneration}\0${source.ownerGeneration}\0${source.deliveryToken}`
}
