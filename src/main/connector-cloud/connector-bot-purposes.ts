// What each shared bot is for, as `bot list` and the @ picker read it (SOUL.md's first paragraph), kept
// for the hello, which is said without reading files: the cloud shows it to the people it is shared with.
import { join } from 'node:path'
import { CONNECTOR_LIMITS } from '../../../cloud/packages/connector-contract/src/connector-limits'
import type { Bot } from '../../shared/bot-types'
import { soulSpecialty } from '../../shared/bot-roster'
import { SerialRerun } from '../../shared/concurrency/serial-rerun'
import { botHomeFolder, localBotHomeFilesystem } from '../bots/bot-home'

export type ConnectorBotPurposesDeps = {
  bots: () => readonly Pick<Bot, 'id' | 'folder' | 'shares'>[]
  /** SOUL.md's text, or null when it can't be read. */
  readSoul?: (bot: Pick<Bot, 'folder'>) => Promise<string | null>
}

const readSoul = (bot: Pick<Bot, 'folder'>): Promise<string | null> =>
  localBotHomeFilesystem.readText(join(botHomeFolder(bot), 'SOUL.md'))

/** A purpose as the hello may carry it: absent when empty, cut to the contract's cap. */
export function helloBotPurpose(soul: string | null): string | undefined {
  const purpose = soulSpecialty(soul)
  const max = CONNECTOR_LIMITS.maxBotPurposeLength
  if (!purpose || purpose.length <= max) {
    return purpose ?? undefined
  }
  // The contract counts UTF-16 units; never end on half a pair.
  const cut = purpose.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

export class ConnectorBotPurposes {
  private kept = new Map<string, string>()
  private readonly reads = new SerialRerun(() => this.read())
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: ConnectorBotPurposesDeps) {}

  of(botId: string): string | undefined {
    return this.kept.get(botId)
  }

  /** Called when a read keeps other purposes than before: the hello says them again. */
  onChange(listener: () => void): void {
    this.listeners.add(listener)
  }

  /** Reads them again; settles once the latest read is kept. */
  refresh(): Promise<void> {
    return this.reads.start()
  }

  private async read(): Promise<void> {
    // Only a shared bot's: nobody else is shown it, and each read is a file.
    const shared = this.deps.bots().filter((bot) => (bot.shares?.length ?? 0) > 0)
    const read = this.deps.readSoul ?? readSoul
    const next = new Map<string, string>()
    for (const bot of shared) {
      const purpose = helloBotPurpose(await read(bot).catch(() => null))
      if (purpose) {
        next.set(bot.id, purpose)
      }
    }
    const before = JSON.stringify([...this.kept])
    this.kept = next
    if (JSON.stringify([...next]) !== before) {
      for (const listener of this.listeners) {
        listener()
      }
    }
  }
}
