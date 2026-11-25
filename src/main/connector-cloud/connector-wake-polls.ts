// A poll client's wake channel (connector-wake-channel.ts), offered by its hello answers.
import type { ConnectorWakeOffer } from '../../../cloud/packages/connector-contract/src/wake-messages'
import type { ConnectorPollClientOptions } from './connector-machine'
import { ConnectorWakeChannel } from './connector-wake-channel'

/** A poll client's wake channel, made by the first hello answer offering one it can use. */
export class ConnectorWakePolls {
  private channel: ConnectorWakeChannel | null = null
  // The hello the last poll went out under: a new one's first poll goes at once.
  private polledRev: number | null = null

  constructor(
    private readonly options: Pick<
      ConnectorPollClientOptions,
      'transport' | 'wakeSocketFactory' | 'machine'
    >,
    private readonly random: () => number,
    /** The client's stop, which ends the channel for good. */
    private readonly stopped: AbortSignal
  ) {
    stopped.addEventListener('abort', () => this.channel?.stop(), { once: true })
  }

  /** Each hello answer's offer; none drops the socket, and polls are held again. */
  offer(offer: ConnectorWakeOffer | null): void {
    const { transport } = this.options
    if (!offer || !transport.wakeToken || this.stopped.aborted) {
      this.channel?.offer(null)
      return
    }
    this.channel ??= new ConnectorWakeChannel({
      token: (renew) => transport.wakeToken?.(renew) ?? Promise.resolve('none'),
      random: this.random,
      socketFactory: this.options.wakeSocketFactory,
      sharesChanged: this.options.machine.sharesChanged
    })
    this.channel.offer(offer)
  }

  requestPoll(): void {
    this.channel?.requestPoll()
  }

  /** The client dropped its hello: a poll waiting under it ends, so the next cycle says hello. */
  helloDropped(): void {
    this.channel?.recheck()
  }

  /**
   * The next poll's holdMs once it is due: undefined to hold as before (no open socket); null with
   * no hello, or when stopped or another hello replaced `helloRev` meanwhile (it polls next cycle).
   */
  async hold(
    helloRev: number | null,
    currentRev: () => number | null,
    signal: AbortSignal
  ): Promise<number | undefined | null> {
    const { channel } = this
    if (helloRev === null) {
      return null
    }
    let holdMs: number | undefined
    if (channel?.active) {
      const stale = (): boolean => currentRev() !== helloRev
      const turn =
        this.polledRev === helloRev ? await channel.nextPoll(signal, stale) : { holdMs: 0 }
      if (signal.aborted || currentRev() !== helloRev) {
        return null
      }
      holdMs = turn?.holdMs
    }
    this.polledRev = helloRev
    channel?.polled()
    return holdMs
  }
}
