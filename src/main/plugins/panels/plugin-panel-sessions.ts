import { randomBytes } from 'node:crypto'

export type PluginPanelSessionBinding = {
  pluginKey: string
  /** Which contribution list `contributionId` names; it also picks the callable methods. */
  surface: 'panel' | 'editor'
  contributionId: string
  rootDir: string
  manifestRevision: string
}

type PluginPanelSession = PluginPanelSessionBinding & {
  ownerKey: string
}

const MAX_PANEL_SESSIONS = 1_024

function bindingKey(ownerKey: string, binding: PluginPanelSessionBinding): string {
  return JSON.stringify([
    ownerKey,
    binding.pluginKey,
    binding.surface,
    binding.contributionId,
    binding.rootDir,
    binding.manifestRevision
  ])
}

/** Bind bearer sessions to transport owners; later actions cannot choose a plugin identity. */
export class PluginPanelSessions {
  private readonly sessions = new Map<string, PluginPanelSession>()
  private readonly tokensByBinding = new Map<string, string>()

  issue(ownerKey: string, binding: PluginPanelSessionBinding): string {
    const key = bindingKey(ownerKey, binding)
    const existing = this.tokensByBinding.get(key)
    if (existing) {
      return existing
    }
    while (this.sessions.size >= MAX_PANEL_SESSIONS) {
      const oldest = this.sessions.entries().next().value as
        | [string, PluginPanelSession]
        | undefined
      if (!oldest) {
        break
      }
      this.delete(oldest[0], oldest[1])
    }
    const token = randomBytes(32).toString('base64url')
    const session = { ownerKey, ...binding }
    this.sessions.set(token, session)
    this.tokensByBinding.set(key, token)
    return token
  }

  resolve(ownerKey: string, token: string): PluginPanelSessionBinding | null {
    const session = this.sessions.get(token)
    if (!session || session.ownerKey !== ownerKey) {
      return null
    }
    return {
      pluginKey: session.pluginKey,
      surface: session.surface,
      contributionId: session.contributionId,
      rootDir: session.rootDir,
      manifestRevision: session.manifestRevision
    }
  }

  revokeOwner(ownerKey: string): void {
    for (const [token, session] of this.sessions) {
      if (session.ownerKey === ownerKey) {
        this.delete(token, session)
      }
    }
  }

  clear(): void {
    this.sessions.clear()
    this.tokensByBinding.clear()
  }

  private delete(token: string, session: PluginPanelSession): void {
    this.sessions.delete(token)
    this.tokensByBinding.delete(bindingKey(session.ownerKey, session))
  }
}
