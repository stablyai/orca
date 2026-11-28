// The connectors a bot host runs itself, with no Orca cloud between them and their IM: told what the
// cloud connector is told, and stopped with the host. A platform adds its own when the connector
// host installs, and reaches it again by its class.

export type LocalConnectorHost = {
  /** Reply outbox rows filled: post what they hold. */
  repliesFilled?(): void
  /** The seam's conversations were reset for another Orca account: watch them again. */
  rewatch?(): void
  /** Ends its transport; settles once what it keeps is on disk. */
  stop(): Promise<void>
}

export class LocalConnectorHosts {
  private readonly hosts = new Set<LocalConnectorHost>()

  /** Adds a connector; the call returned removes it. */
  add(host: LocalConnectorHost): () => void {
    this.hosts.add(host)
    return () => {
      this.hosts.delete(host)
    }
  }

  /** The connector of a platform's class, for that platform's own RPC methods. */
  find<T extends LocalConnectorHost>(kind: abstract new (...args: never[]) => T): T | null {
    for (const host of this.hosts) {
      if (host instanceof kind) {
        return host
      }
    }
    return null
  }

  repliesFilled(): void {
    for (const host of this.hosts) {
      host.repliesFilled?.()
    }
  }

  rewatch(): void {
    for (const host of this.hosts) {
      host.rewatch?.()
    }
  }

  /** Stops every connector; one that fails doesn't hold up the others' saves. */
  async stop(): Promise<void> {
    const stopped = await Promise.allSettled([...this.hosts].map((host) => host.stop()))
    for (const each of stopped) {
      if (each.status === 'rejected') {
        console.warn('[local-connectors] a connector did not stop cleanly', each.reason)
      }
    }
  }
}
