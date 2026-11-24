import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'

/** A bot's Linear thread shows its work's pull requests beside it; each is told once. Other
 *  sources show none, so their turn ends never wait on the lookup. */
export class ToldWorkLinks {
  // The pull request links each chat's conversation was told of.
  private readonly told = new Map<string, Set<string>>()

  constructor(
    private readonly read: (link: ExternalConversationLink) => Promise<ConnectorWorkLink[]>
  ) {}

  async next(paneKey: string, link: ExternalConversationLink): Promise<ConnectorWorkLink[]> {
    if (!link.bot || link.source !== 'linear') {
      return []
    }
    const told = this.told.get(paneKey) ?? new Set<string>()
    this.told.set(paneKey, told)
    const links = (await this.read(link).catch(() => [])).filter(({ url }) => !told.has(url))
    links.forEach(({ url }) => told.add(url))
    return links
  }

  clear(): void {
    this.told.clear()
  }
}
