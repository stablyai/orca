import { CHAT_FORK_TRANSFER_MAX_SESSIONS } from '../../../shared/ai-vault/fork-transfer/chat-fork-transfer-limits'
import type { ChatForkImportLaunch } from './chat-fork-transfer-ownership'
import {
  clearChatForkIdleTimer,
  restartChatForkIdleTimer,
  type Timed
} from './chat-fork-transfer-slots'

type LaunchEntry = Timed & { launch: ChatForkImportLaunch }

/** Placed imports a terminal create may still launch; a caller only ever evicts its own. */
export class ChatForkImportLaunches {
  private readonly entries = new Map<string, LaunchEntry>()

  constructor(private readonly idleMs: number) {}

  record(owner: string, importId: string, launch: ChatForkImportLaunch): void {
    const mine = [...this.entries].filter(([, entry]) => entry.owner === owner)
    if (mine.length >= CHAT_FORK_TRANSFER_MAX_SESSIONS) {
      this.drop(mine[0][0])
    }
    const entry: LaunchEntry = { owner, timer: null, launch: { ...launch } }
    this.entries.set(importId, entry)
    restartChatForkIdleTimer(entry, this.idleMs, () => this.drop(importId))
  }

  /** Not consumed, so a lost-response retry of the same create or commit still finds it. */
  find(owner: string, importId: string): ChatForkImportLaunch | null {
    const entry = this.entries.get(importId)
    return entry?.owner === owner ? { ...entry.launch } : null
  }

  clear(): void {
    for (const id of this.entries.keys()) {
      this.drop(id)
    }
  }

  private drop(id: string): void {
    const entry = this.entries.get(id)
    if (entry) {
      clearChatForkIdleTimer(entry)
      this.entries.delete(id)
    }
  }
}
