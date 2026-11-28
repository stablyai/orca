import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationEnvironmentTransport } from '../environment-transport'
import type { PeerMailRelay, PeerServerAnswerStatus } from './peer-mail-relay'

/** Defers loading the peer-mail relay and its federation/remote-owned graph until first use. */
export class LazyPeerMailRelay {
  private relay: PeerMailRelay | undefined
  private loadPromise: Promise<PeerMailRelay> | undefined
  private generation = 0

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly getTransport: () => OrchestrationEnvironmentTransport | null
  ) {}

  ensure(environmentId?: string): void {
    if (this.relay) {
      this.relay.ensure(environmentId)
      return
    }
    const generation = this.generation
    const load = (this.loadPromise ??= import('./peer-mail-relay').then(
      ({ PeerMailRelay }) => (this.relay ??= new PeerMailRelay(this.runtime, this.getTransport))
    ))
    void load
      .then((relay) => {
        if (this.generation !== generation) {
          return
        }
        relay.ensure(environmentId)
      })
      .catch((error: unknown) => {
        if (this.generation === generation && this.loadPromise === load) {
          this.loadPromise = undefined
        }
        console.warn('[peer-mail] failed to load peer mail relay:', error)
      })
  }

  answerStatus(environmentId: string): PeerServerAnswerStatus | undefined {
    return this.relay?.answerStatus(environmentId)
  }

  stop(): void {
    this.generation += 1
    this.loadPromise = undefined
    this.relay?.stop()
  }
}
