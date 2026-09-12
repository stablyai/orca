import { TransportPublicationDrain } from '../shared/transport-publication-drain'
import type { RelayDispatcher } from './dispatcher'

type PublicationDispatcher = Pick<
  RelayDispatcher,
  'publishProducerNotification' | 'assertSettledProducerTransport'
>

/** Local write completion only; the tunnel separately proves downstream consumption. */
export class RelayProducerPublicationDrain extends TransportPublicationDrain {
  constructor(
    private readonly dispatcher: PublicationDispatcher,
    private readonly clientId: number,
    private readonly transportGeneration: number,
    assertAuthority: () => void,
    onFailure: (error: Error) => void = () => {}
  ) {
    super(() => {
      assertAuthority()
      dispatcher.assertSettledProducerTransport(clientId, transportGeneration)
    }, onFailure)
  }

  publish(method: string, params: Record<string, unknown>): boolean {
    const settle = this.trackWrite()
    try {
      this.assertCurrent()
      const accepted = this.dispatcher.publishProducerNotification(this.clientId, method, params, {
        logDrop: false,
        settledTransportGeneration: this.transportGeneration,
        isStillAdmitted: () => {
          try {
            this.assertCurrent()
            return true
          } catch {
            return false
          }
        },
        onSettled: settle
      })
      if (!accepted) {
        settle({ ok: false, error: new Error('relay_producer_publication_refused') })
      }
      return accepted && !this.failure
    } catch (error) {
      settle({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
      return false
    }
  }
}
