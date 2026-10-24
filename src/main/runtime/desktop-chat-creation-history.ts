import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'

/** Desktop minting facts, shared by every window and retained until an environment is removed. */
export class DesktopChatCreationHistory {
  private readonly byEnvironment = new Map<string, Set<string>>()
  private readonly writer: AtomicSnapshotWriter

  constructor(userDataPath: string) {
    const file = join(userDataPath, 'desktop-chat-creation-history.json')
    this.writer = new AtomicSnapshotWriter(() => file, { fileMode: 0o600, skipUnchanged: true })
    try {
      const content = readFileSync(file, 'utf8')
      const saved: unknown = JSON.parse(content)
      this.writer.primeCommittedContent(content)
      if (saved && typeof saved === 'object') {
        for (const [environmentId, ids] of Object.entries(saved)) {
          if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
            this.byEnvironment.set(environmentId, new Set<string>(ids))
          }
        }
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        console.warn('[desktop-chat-history] Could not read creation history:', error)
      }
    }
  }

  async recordCreate(environmentId: string, method: string, params: unknown): Promise<void> {
    if (method !== 'agentSession.create' || !params || typeof params !== 'object') {
      return
    }
    if (!('envelope' in params) || !params.envelope || typeof params.envelope !== 'object') {
      return
    }
    const envelope = params.envelope
    if (!('sessionId' in envelope) || typeof envelope.sessionId !== 'string') {
      return
    }
    const ids = this.byEnvironment.get(environmentId) ?? new Set<string>()
    ids.add(envelope.sessionId)
    this.byEnvironment.set(environmentId, ids)
    await this.save()
  }

  sessionIds(): string[] {
    return [...new Set([...this.byEnvironment.values()].flatMap((ids) => [...ids]))]
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    if (this.byEnvironment.delete(environmentId)) {
      await this.save()
    }
  }

  private async save(): Promise<void> {
    try {
      await this.writer.write(() =>
        JSON.stringify(
          Object.fromEntries([...this.byEnvironment].map(([id, ids]) => [id, [...ids]]))
        )
      )
    } catch (error) {
      console.warn('[desktop-chat-history] Could not save creation history:', error)
    }
  }
}

const histories = new Map<string, DesktopChatCreationHistory>()
export function desktopChatCreationHistory(userDataPath: string): DesktopChatCreationHistory {
  let history = histories.get(userDataPath)
  if (!history) {
    history = new DesktopChatCreationHistory(userDataPath)
    histories.set(userDataPath, history)
  }
  return history
}
