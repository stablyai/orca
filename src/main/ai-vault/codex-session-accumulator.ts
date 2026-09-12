import type { AiVaultSession } from '../../shared/ai-vault-types'
import { codexSessionAliasBeats, codexSessionAliasKey } from './codex-session-root-dedup'

/** Retains canonical rows in their original occurrence order without holding discarded aliases. */
export class CodexSessionAccumulator {
  private readonly rows = new Map<number, AiVaultSession>()
  private readonly aliases = new Map<string, { session: AiVaultSession; positions: number[] }>()
  private nextPosition = 0

  get size(): number {
    return this.rows.size
  }

  add(session: AiVaultSession): void {
    const key = codexSessionAliasKey(session)
    const position = this.nextPosition++
    if (key) {
      const best = this.aliases.get(key)
      if (best && best.session !== session) {
        if (!codexSessionAliasBeats(session, best.session)) {
          return
        }
        for (const previous of best.positions) {
          this.rows.delete(previous)
        }
      }
      if (best?.session === session) {
        best.positions.push(position)
      } else {
        this.aliases.set(key, { session, positions: [position] })
      }
    }
    this.rows.set(position, session)
  }

  sessions(): AiVaultSession[] {
    return [...this.rows.values()]
  }
}
