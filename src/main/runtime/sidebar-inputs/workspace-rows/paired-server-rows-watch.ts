import type {
  MobileDesktopRelayHosts,
  MobileDesktopRelayHostWatch
} from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import type { ServerEntry } from './paired-server-rows-state'

/** Hears each paired server's agent-row change notices from the watch kept while it is in contact. */
export class PairedServerAgentRowsChanges {
  private readonly listeners = new Set<(environmentId: string) => void>()

  onChange(listener: (environmentId: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(environmentId: string): void {
    for (const listener of this.listeners) {
      listener(environmentId)
    }
  }
}

export function watchPairedServerRows(
  hosts: MobileDesktopRelayHosts,
  entry: ServerEntry,
  owner: {
    attachment: () => object | null
    current: (entry: ServerEntry) => boolean
    refresh: (environmentId: string) => Promise<void>
    agentRowsChanged: PairedServerAgentRowsChanges
  }
): void {
  const attachment = owner.attachment()
  const setup = {}
  const contactGeneration = entry.contactGeneration
  entry.watchSetup = setup
  let closed = false
  let installed: MobileDesktopRelayHostWatch | null = null
  const current = (): boolean =>
    owner.attachment() === attachment &&
    owner.current(entry) &&
    entry.watchSetup === setup &&
    entry.inContact
  void Promise.resolve()
    .then(() => {
      if (!current()) {
        return null
      }
      return hosts.watchChanges({ environmentId: entry.environmentId }, entry.identity, {
        onChange: ({ catalog }) => {
          if (current()) {
            entry.refreshAgain ||= entry.refreshing !== null
            entry.catalogStale ||= catalog
            void owner.refresh(entry.environmentId)
          }
        },
        onRowsChanged: () => {
          if (current()) {
            owner.agentRowsChanged.emit(entry.environmentId)
          }
        },
        onClose: () => {
          closed = true
          if (current() && entry.watch === installed) {
            entry.watch = null
            entry.watchSetup = null
          }
        }
      })
    })
    .then((watch) => {
      if (!watch) {
        return
      }
      if (
        !current() ||
        closed ||
        contactGeneration !== entry.contactGeneration ||
        !watch.current()
      ) {
        watch.close()
        if (entry.watchSetup === setup) {
          entry.watchSetup = null
        }
        return
      }
      installed = watch
      entry.watch = watch
    })
    .catch((error: unknown) => {
      if (entry.watchSetup === setup) {
        entry.watchSetup = null
      }
      console.warn('[paired-server-rows] could not watch server', error)
    })
}
