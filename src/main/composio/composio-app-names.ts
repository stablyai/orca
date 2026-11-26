// App names by slug, from the app list and single reads, so a sign-in shows its app's name.
import type { ComposioApp, ComposioConnection } from '../../shared/composio/composio-apps'

export class ComposioAppNames {
  private readonly names = new Map<string, string>()

  remember(apps: readonly ComposioApp[]): void {
    for (const app of apps) {
      this.names.set(app.slug, app.name)
    }
  }

  /** The sign-ins with their apps' names, reading the apps not seen yet; a failed read keeps the slug. */
  async named(
    read: (slug: string) => Promise<ComposioApp>,
    connections: ComposioConnection[]
  ): Promise<ComposioConnection[]> {
    const unknown = [...new Set(connections.map((entry) => entry.app))].filter(
      (slug) => !this.names.has(slug)
    )
    await Promise.all(
      unknown.map((slug) =>
        read(slug).then(
          (app) => this.names.set(slug, app.name),
          () => undefined
        )
      )
    )
    return connections.map((entry) => ({ ...entry, name: this.names.get(entry.app) ?? entry.app }))
  }
}
