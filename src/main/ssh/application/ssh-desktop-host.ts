/** Native effects the SSH application needs from whichever process hosts the desktop windows. */
export type SshDesktopHost = {
  /** Delivers an SSH event to the main window's document; false when no document can receive it. */
  publish(channel: string, payload?: unknown): boolean
  /** Whether publish would reach a document now; lets costly payloads be skipped. */
  hasDocument(): boolean
  /** Repositories changed under a target rename; windows and paired clients refetch them. */
  reposChanged(): void
  /** Wake or unlock; returns an unsubscribe. */
  onHostResume(listener: () => void): () => void
  /** Retires a removed target's scoped browser storage. */
  clearTargetBrowserStorage(targetId: string): Promise<void>
}

const detachedHost: SshDesktopHost = {
  publish: () => false,
  hasDocument: () => false,
  reposChanged: () => {},
  onHostResume: () => () => {},
  clearTargetBrowserStorage: async () => {}
}

let installedHost: SshDesktopHost = detachedHost

export function setSshDesktopHost(host: SshDesktopHost | null): void {
  installedHost = host ?? detachedHost
}

export function sshDesktopHost(): SshDesktopHost {
  return installedHost
}
