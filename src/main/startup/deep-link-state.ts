import {
  formatBotAccessRequestDeepLink,
  formatBotDeepLink,
  parseBotAccessRequestDeepLink,
  parseBotDeepLink,
  type BotAccessRequestDeepLink,
  type BotDeepLink,
  type ConnectorLinkDeepLink,
  type ConnectorLinkSource
} from '../../shared/bot-deep-link'
import {
  botShareIdFromArguments,
  skillShareIdFromArguments
} from '../../shared/skills/sharing/skill-share-link'
import { formatConnectorLinkDeepLink, parseConnectorLinkDeepLink } from './connector-link-deep-link'
import {
  formatWorktreeDeepLink,
  parseWorktreeDeepLink,
  type WorktreeDeepLink
} from './open-routing/worktree-deep-link'
import { PendingDeepLinkState } from './open-routing/skill-share-deep-link-state'

export type DeepLink =
  | { kind: 'skill-share'; shareId: string }
  | { kind: 'bot-share'; shareId: string }
  | { kind: 'bot'; link: BotDeepLink }
  | { kind: 'connector-link'; link: ConnectorLinkDeepLink }
  | { kind: 'access-request'; link: BotAccessRequestDeepLink }
  | { kind: 'worktree'; link: WorktreeDeepLink }

function deepLinkOf(value: string): DeepLink | null {
  const accessRequest = parseBotAccessRequestDeepLink(value)
  if (accessRequest) {
    return { kind: 'access-request', link: accessRequest }
  }
  const bot = parseBotDeepLink(value)
  if (bot) {
    return { kind: 'bot', link: bot }
  }
  const connector = parseConnectorLinkDeepLink(value)
  if (connector) {
    return { kind: 'connector-link', link: connector }
  }
  const worktree = parseWorktreeDeepLink(value)
  if (worktree) {
    return { kind: 'worktree', link: worktree }
  }
  const botShareId = botShareIdFromArguments([value])
  if (botShareId) {
    return { kind: 'bot-share', shareId: botShareId }
  }
  const shareId = skillShareIdFromArguments([value])
  return shareId ? { kind: 'skill-share', shareId } : null
}

/** Holds the latest link of each kind until the renderer pulls it. */
export class DeepLinkState {
  // Skill and bot shares keep the shared repeat-click and burst guard.
  private readonly skillShares: PendingDeepLinkState
  private readonly botShares: PendingDeepLinkState
  private readonly worktreeLinks: PendingDeepLinkState
  private pendingBotLink: BotDeepLink | null = null
  // The latest link of each service, so a GitHub link never replaces a Linear one.
  private readonly pendingConnectorLinks = new Map<ConnectorLinkSource, ConnectorLinkDeepLink>()
  private pendingAccessRequest: BotAccessRequestDeepLink | null = null

  constructor(now?: () => number) {
    this.skillShares = new PendingDeepLinkState(([shareId]) => shareId ?? null, now)
    this.botShares = new PendingDeepLinkState(([shareId]) => shareId ?? null, now)
    this.worktreeLinks = new PendingDeepLinkState(([selector]) => selector ?? null, now)
  }

  /** Whether macOS `open-url` should claim this URL. */
  accepts(url: string): boolean {
    return deepLinkOf(url) !== null
  }

  /** True when argv held a link; a handoff can carry one of each kind. */
  capture(argv: readonly string[], publish?: (link: DeepLink) => void): boolean {
    const links = argv.flatMap((value) => deepLinkOf(value) ?? [])
    for (const link of links) {
      if (link.kind === 'skill-share') {
        this.skillShares.capture([link.shareId], () => publish?.(link))
        continue
      }
      if (link.kind === 'bot-share') {
        this.botShares.capture([link.shareId], () => publish?.(link))
        continue
      }
      if (link.kind === 'worktree') {
        this.worktreeLinks.capture([link.link.selector], () => publish?.(link))
        continue
      }
      if (link.kind === 'bot') {
        this.pendingBotLink = link.link
      } else if (link.kind === 'access-request') {
        this.pendingAccessRequest = link.link
      } else {
        this.pendingConnectorLinks.set(link.link.source, link.link)
      }
      publish?.(link)
    }
    return links.length > 0
  }

  consumeSkillShare(): string | null {
    return this.skillShares.consume()
  }

  consumeBotShare(): string | null {
    return this.botShares.consume()
  }

  consumeWorktreeLink(): string | null {
    return this.worktreeLinks.consume()
  }

  consumeBotLink(): BotDeepLink | null {
    const link = this.pendingBotLink
    this.pendingBotLink = null
    return link
  }

  /** One pending service link, or null; pull again for another. */
  consumeConnectorLink(): ConnectorLinkDeepLink | null {
    const [link] = this.pendingConnectorLinks.values()
    if (!link) {
      return null
    }
    this.pendingConnectorLinks.delete(link.source)
    return link
  }

  consumeAccessRequest(): BotAccessRequestDeepLink | null {
    const link = this.pendingAccessRequest
    this.pendingAccessRequest = null
    return link
  }

  /** Bots off: links that act on the account's bots are dropped. */
  discardConnectorLinks(): void {
    this.pendingConnectorLinks.clear()
    this.pendingAccessRequest = null
    this.botShares.consume()
  }

  /** Pending links as launch arguments for another instance. */
  drainArguments(): string[] {
    const shareId = this.consumeSkillShare()
    const bot = this.consumeBotLink()
    const connectorLinks = [...this.pendingConnectorLinks.values()]
    this.pendingConnectorLinks.clear()
    const accessRequest = this.consumeAccessRequest()
    const botShareId = this.consumeBotShare()
    const worktreeSelector = this.consumeWorktreeLink()
    return [
      ...(shareId ? [`orca://skills/share/${shareId}`] : []),
      ...(bot ? [formatBotDeepLink(bot)] : []),
      ...connectorLinks.map(formatConnectorLinkDeepLink),
      ...(accessRequest ? [formatBotAccessRequestDeepLink(accessRequest)] : []),
      ...(botShareId ? [`orca://bots/share/${botShareId}`] : []),
      ...(worktreeSelector ? [formatWorktreeDeepLink({ selector: worktreeSelector })] : [])
    ]
  }
}
