// Which repository events start which ngit rules. Everything a Nostr author wrote goes into the run
// event's quoted fields.
import { npubEncode } from 'nostr-tools/nip19'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import {
  NGIT_ANYONE,
  type AutomationNgitTrigger,
  type NgitEventKind
} from '../../shared/automation-ngit-triggers'
import { NOSTR_KIND } from './nostr-event-kinds'
import type { NostrEvent } from './nostr-event-tags'
import type { NostrRepositorySnapshot } from './repository-snapshot'
import type { ProjectedWorkItem } from './work-item-projection'

export type NgitOccurrence = {
  kind: NgitEventKind
  /** The Nostr event that happened: the item, a push, a status or a comment. */
  event: NostrEvent
  item: ProjectedWorkItem
}

function occurrenceKind(item: ProjectedWorkItem, event: NostrEvent): NgitEventKind | null {
  const isIssue = item.item.type === 'issue'
  switch (event.kind) {
    case NOSTR_KIND.issue:
      return 'issue_opened'
    case NOSTR_KIND.pullRequest:
      return event.id === item.item.eventId ? 'pr_opened' : 'pr_pushed'
    case NOSTR_KIND.patch:
      return event.id === item.item.eventId ? 'pr_opened' : 'pr_pushed'
    case NOSTR_KIND.pullRequestUpdate:
      return 'pr_pushed'
    case NOSTR_KIND.statusApplied:
      return isIssue ? 'issue_closed' : 'pr_merged'
    case NOSTR_KIND.statusClosed:
      return isIssue ? 'issue_closed' : 'pr_closed'
    case NOSTR_KIND.comment:
    case NOSTR_KIND.legacyReply:
      return 'comment'
    default:
      return null
  }
}

export function repositoryOccurrences(snapshot: NostrRepositorySnapshot): NgitOccurrence[] {
  return snapshot.items.flatMap((item) =>
    [item.root, ...item.activity, ...item.comments].flatMap((event) => {
      const kind = occurrenceKind(item, event)
      return kind ? [{ kind, event, item }] : []
    })
  )
}

export function ngitRuleMatches(
  rule: AutomationNgitTrigger,
  occurrence: NgitOccurrence,
  maintainers: readonly string[],
  ownNpub: string | null
): boolean {
  const { event, item, kind } = occurrence
  if (rule.event !== kind) {
    return false
  }
  const author = npubEncode(event.pubkey)
  const named = rule.from?.includes(author) === true
  // The bot publishes as its owner, so the owner's own events start only a rule that names them.
  if (author === ownNpub && !named) {
    return false
  }
  // Anyone on Nostr can publish to a repository, so strangers start only a rule that says so.
  const allowed = rule.from?.length
    ? named || rule.from.includes(NGIT_ANYONE)
    : maintainers.includes(event.pubkey)
  if (!allowed || (rule.subject && !item.item.eventId.startsWith(rule.subject))) {
    return false
  }
  return (
    !rule.textContains ||
    `${item.item.title}\n${event.content}`.toLowerCase().includes(rule.textContains.toLowerCase())
  )
}

export function ngitRunEvent(
  rule: AutomationNgitTrigger,
  { event, item }: NgitOccurrence,
  repositoryName: string
): AutomationRunEvent {
  const author = npubEncode(event.pubkey)
  const name = item.commentProfiles.get(event.pubkey)?.name
  return {
    triggerId: rule.id,
    source: 'ngit',
    event: rule.event,
    key: `ngit:${event.id}`,
    // Later events on one issue or pull request fold into its unfinished run.
    subject: `ngit:${item.item.eventId}`,
    occurredAt: event.created_at * 1000,
    actor: name ? `${name} (${author})` : author,
    actorId: author,
    place: repositoryName,
    url: item.item.url,
    text: [`${item.item.title} (${item.item.eventId})`, event.content].filter(Boolean).join('\n')
  }
}
