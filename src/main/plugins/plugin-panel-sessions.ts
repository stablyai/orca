import { randomBytes } from 'node:crypto'
import type { PluginPanelSurface } from '../../shared/plugins/plugin-panel-bridge'

export type PluginPanelSessionBinding = {
  pluginKey: string
  /** Contribution id: a panel id, or a settings page id when `surface` says so. */
  panelId: string
  surface: PluginPanelSurface
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
    binding.panelId,
    binding.surface,
    binding.rootDir,
    binding.manifestRevision
  ])
}

/** Opaque bearer sessions bind a loaded panel to its transport owner without
 *  accepting a plugin identity on later action calls. */
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

  /** Resolves only sessions for `surfaces`. Why panels by default: a caller
   *  that predates settings pages (say, a channel keyed by panel id) must never
   *  accept a settings page token as a panel. */
  resolve(
    ownerKey: string,
    token: string,
    surfaces: readonly PluginPanelSurface[] = ['panel']
  ): PluginPanelSessionBinding | null {
    const session = this.sessions.get(token)
    if (!session || session.ownerKey !== ownerKey || !surfaces.includes(session.surface)) {
      return null
    }
    return {
      pluginKey: session.pluginKey,
      panelId: session.panelId,
      surface: session.surface,
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
