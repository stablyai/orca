// A signed-in desktop with no poll client: one hello for the wake offer, then only the wake socket, so
// a share added or revoked reaches it in seconds. It never polls the inbox; the poll client replaces it.
import { connectorStop } from './connector-cloud-request'
import { connectorHelloSaid, sayConnectorHello } from './connector-hello'
import type { ConnectorMachine, ConnectorTransport } from './connector-machine'
import { ConnectorWakeChannel } from './connector-wake-channel'
import type { ConnectorWakeSocketFactory } from './connector-wake-socket'

// Picks up a wake rollout, or a socket refused until the next hello.
const REHELLO_MS = 60 * 60_000
const RETRY_MS = 5 * 60_000

export class ConnectorShareWake {
  private readonly stopped = new AbortController()
  private readonly channel: ConnectorWakeChannel
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly options: {
      transport: ConnectorTransport
      machine: ConnectorMachine
      random?: () => number
      wakeSocketFactory?: ConnectorWakeSocketFactory
    }
  ) {
    const { transport, machine } = options
    this.channel = new ConnectorWakeChannel({
      token: (renew) => transport.wakeToken?.(renew) ?? Promise.resolve('none'),
      random: options.random ?? Math.random,
      socketFactory: options.wakeSocketFactory,
      sharesChanged: machine.sharesChanged
    })
  }

  start(): void {
    void this.hello()
  }

  stop(): void {
    this.stopped.abort()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.channel.stop()
  }

  private async hello(): Promise<void> {
    const { machine, transport } = this.options
    const sent = await sayConnectorHello(
      machine,
      connectorHelloSaid(machine, null),
      transport,
      this.stopped.signal
    ).catch(() => null)
    if (this.stopped.signal.aborted) {
      return
    }
    if (sent?.ok) {
      this.channel.offer(sent.value.answer.wake ?? null)
      machine.helloAnswered?.(sent.value.answer)
    } else if (sent && connectorStop(sent)) {
      // Refused for good (e.g. sign in again): the next sign-in starts a fresh one.
      return
    }
    this.timer = setTimeout(() => void this.hello(), sent?.ok ? REHELLO_MS : RETRY_MS)
    this.timer.unref?.()
  }
}

/** At most one share wake, for the transport's account; replaced when the account changes. */
export class ConnectorShareWakeHold {
  private held: { transport: ConnectorTransport; wake: ConnectorShareWake } | null = null

  constructor(
    private readonly options: () => {
      machine: ConnectorMachine
      wakeSocketFactory?: ConnectorWakeSocketFactory
    }
  ) {}

  /** Null while signed out or while a poll client runs: its own socket hears the frame. */
  hold(transport: ConnectorTransport | null): void {
    const { machine, wakeSocketFactory } = this.options()
    const next = machine.sharesChanged ? transport : null
    if (this.held?.transport === next) {
      return
    }
    this.held?.wake.stop()
    this.held = null
    if (next) {
      this.held = {
        transport: next,
        wake: new ConnectorShareWake({ transport: next, machine, wakeSocketFactory })
      }
      this.held.wake.start()
    }
  }
}
