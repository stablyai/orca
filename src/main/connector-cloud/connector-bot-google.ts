// Which shared bots' Google works, as `orca bot connectors` reads it (botGoogleConnectState), kept for the
// hello, which is said without reading credentials: a teammate's invite lists Google for them.
import type { Bot } from '../../shared/bot-types'
import { botGoogleConnectState } from '../../shared/google/google-bot-connect-state'
import type { GoogleAccountView } from '../../shared/google/google-connect-types'
import { SerialRerun } from '../../shared/concurrency/serial-rerun'

export type ConnectorBotGoogleDeps = {
  bots: () => readonly Pick<Bot, 'id' | 'shares' | 'google' | 'googleAccounts'>[]
  /** This host's Google accounts; null where Google isn't installed. */
  accounts: () => Promise<readonly GoogleAccountView[]> | null
}

export class ConnectorBotGoogle {
  private kept = new Set<string>()
  private readonly reads = new SerialRerun(() => this.read())
  private readonly listeners = new Set<() => void>()
  // Bot writes waiting on a read to say their hello; a change their hello carries tells no listener.
  private writesWaiting = 0

  constructor(private readonly deps: ConnectorBotGoogleDeps) {}

  works(botId: string): boolean {
    return this.kept.has(botId)
  }

  /** Called when a read keeps other bots than before: the hello says them again. */
  onChange(listener: () => void): void {
    this.listeners.add(listener)
  }

  /** Reads them again; settles once the latest read is kept. */
  refresh(): Promise<void> {
    return this.reads.start()
  }

  /** A bot write's one hello, said once a read has kept what the write changed (a share, Google on). */
  async botsWritten(hello: () => void): Promise<void> {
    this.writesWaiting += 1
    try {
      await this.reads.start()
    } finally {
      this.writesWaiting -= 1
      hello()
    }
  }

  private async read(): Promise<void> {
    // Only a shared bot with Google on: nobody else's card is shown, and none means no read.
    const shared = this.deps
      .bots()
      .filter((bot) => (bot.shares?.length ?? 0) > 0 && bot.google === true)
    const accounts = shared.length > 0 ? await (this.deps.accounts()?.catch(() => []) ?? []) : []
    const next = new Set(
      shared
        .filter((bot) => {
          const state = botGoogleConnectState(bot, { client: null, accounts })
          return state.allowed && state.host === 'connected'
        })
        .map((bot) => bot.id)
    )
    const changed = next.size !== this.kept.size || [...next].some((id) => !this.kept.has(id))
    this.kept = next
    if (changed && this.writesWaiting === 0) {
      for (const listener of this.listeners) {
        listener()
      }
    }
  }
}
