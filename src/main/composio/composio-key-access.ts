import type { ComposioKey, ComposioKeyState } from '../../shared/composio/composio-apps'
import type { ComposioApi } from './composio-api'
import { composioProjectOf } from './composio-cleanup'
import { ComposioKeyHealth } from './composio-key-health'

export type ComposioKeyStore = {
  read: () => string | null | Promise<string | null>
  save: (key: string) => unknown
  clear: () => unknown
}

export class ComposioKeyAccess {
  protected readonly health: ComposioKeyHealth
  constructor(
    private readonly keys: ComposioKeyStore,
    protected readonly api: (key: string) => ComposioApi,
    onChange: () => void
  ) {
    this.health = new ComposioKeyHealth(onChange)
  }
  /** The saved key's project, by its fingerprint; null without a key. */
  async project(): Promise<string | null> {
    const key = await this.keys.read()
    return key ? composioProjectOf(key) : null
  }

  async keyState(): Promise<ComposioKeyState> {
    let key: string | null
    try {
      key = await this.keys.read()
    } catch {
      return 'unreadable'
    }
    return key === null ? 'none' : this.health.rejected ? 'rejected' : 'ok'
  }

  async key(): Promise<ComposioKey> {
    return { key: await this.keyState(), hint: (await this.keys.read())?.slice(-4) ?? null }
  }

  private async requireKey(): Promise<string> {
    const key = await this.keys.read()
    if (!key) {
      throw new Error('Add your Composio key first.')
    }
    return key
  }

  /** Runs a call with the saved key, noting when Composio refuses it so every client can say so.
   *  While a limit holds only a deliberate call goes out. */
  async withKey<T>(
    call: (api: ComposioApi, credential: { key: string; project: string }) => Promise<T>,
    options: { deliberate?: boolean } = {}
  ): Promise<T> {
    const key = await this.requireKey()
    const api = this.api(key)
    const held = options.deliberate ? null : this.health.holding()
    if (held) {
      throw held
    }
    const ticket = this.health.ticket()
    // A replaced key's late answer is its caller's alone; it says nothing about the saved key.
    const current = async () => (await this.keys.read()) === key
    try {
      const result = await call(api, { key, project: composioProjectOf(key) })
      if (await current()) {
        this.health.answered(ticket)
      }
      return result
    } catch (error) {
      if (await current()) {
        this.health.failed(error)
      }
      throw error
    }
  }
}
