import { neventEncode, npubEncode } from 'nostr-tools/nip19'
import type {
  NgitComment,
  NgitPatch,
  NgitWorkItem,
  NgitWorkItemState
} from '../../shared/ngit/ngit-work-item-types'
import { NOSTR_KIND, STATUS_KINDS } from './nostr-event-kinds'
import {
  byNewest,
  hasTag,
  isPatchRevision,
  tagValue,
  tagValues,
  type NostrEvent
} from './nostr-event-tags'
import type { NostrRepository } from './repository-announcement'

const PATCH_MARKER_TAGS = new Set(['root', 'root-revision', 'revision-root'])

export type NostrProfile = { name: string | null; picture: string | null }

/** A work item before it is stamped with the Orca repo that asked for it. */
export type ProjectedWorkItem = {
  item: Omit<NgitWorkItem, 'repoId' | 'id'>
  authorPubkey: string
  body: string
  comments: NostrEvent[]
  commentProfiles: ReadonlyMap<string, NostrProfile>
  patches: NgitPatch[]
  cloneUrls: string[]
}

export function nostrItemNumber(eventId: string): number {
  // Zero is not a valid review number.
  return Number.parseInt(eventId.slice(0, 8), 16) || 1
}

function isPatchRoot(event: NostrEvent): boolean {
  return event.kind === NOSTR_KIND.patch && hasTag(event, 't', 'root') && !isPatchRevision(event)
}

export function isWorkItemRoot(event: NostrEvent): boolean {
  return (
    event.kind === NOSTR_KIND.issue || event.kind === NOSTR_KIND.pullRequest || isPatchRoot(event)
  )
}

function referencedIds(event: NostrEvent): string[] {
  return [...tagValues(event, 'e'), ...tagValues(event, 'E')]
}

function patchMessage(content: string): { subject: string; body: string } {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => line.startsWith('Subject:'))
  if (start === -1) {
    return { subject: lines[0] ?? '', body: '' }
  }
  let end = start + 1
  // Mail headers fold long subjects onto indented lines.
  while (lines[end]?.startsWith(' ')) {
    end++
  }
  const subject = lines
    .slice(start, end)
    .join('')
    .replace(/^Subject:\s*(\[[^\]]*\]\s*)?/, '')
    .trim()
  const rest = lines.slice(end).join('\n')
  const separator = rest.indexOf('\n---\n')
  return { subject, body: (separator === -1 ? '' : rest.slice(0, separator)).trim() }
}

function issueTitle(event: NostrEvent): string {
  return tagValue(event, 'subject') || event.content.split('\n')[0]?.slice(0, 120) || 'Untitled'
}

function newestLabelValue(labels: NostrEvent[], namespace: string): string | undefined {
  for (const event of labels) {
    const label = event.tags.find((tag) => tag[0] === 'l' && tag[2] === namespace)
    if (label?.[1]) {
      return label[1]
    }
  }
  return undefined
}

function itemState(root: NostrEvent, status: NostrEvent | undefined): NgitWorkItemState {
  switch (status?.kind) {
    case NOSTR_KIND.statusApplied:
      return root.kind === NOSTR_KIND.issue ? 'closed' : 'merged'
    case NOSTR_KIND.statusClosed:
      return 'closed'
    case NOSTR_KIND.statusDraft:
      return 'draft'
    case undefined:
    default:
      return 'open'
  }
}

/** The newest revision's patches, oldest first; the series tip is the last. */
function patchSeries(root: NostrEvent, related: NostrEvent[], trusted: (e: NostrEvent) => boolean) {
  const patches = related.filter((e) => e.kind === NOSTR_KIND.patch && trusted(e))
  const revision = patches.filter(isPatchRevision).toSorted(byNewest)[0] ?? root
  const series = [
    revision,
    ...patches.filter((e) => e.id !== revision.id && referencedIds(e).includes(revision.id))
  ]
  // Commit parentage orders a series reliably; timestamps within one send often collide.
  const byParent = new Map(series.map((e) => [tagValue(e, 'parent-commit'), e]))
  const commits = new Set(series.map((e) => tagValue(e, 'commit')))
  let next = series.find((e) => !commits.has(tagValue(e, 'parent-commit')))
  const ordered: NostrEvent[] = []
  while (next && !ordered.includes(next)) {
    ordered.push(next)
    next = byParent.get(tagValue(next, 'commit'))
  }
  return ordered.length === series.length
    ? ordered
    : series.toSorted((a, b) => a.created_at - b.created_at)
}

function authorName(pubkey: string, profiles: ReadonlyMap<string, NostrProfile>): string {
  return profiles.get(pubkey)?.name || `${npubEncode(pubkey).slice(0, 12)}…`
}

export function projectNostrComment(
  event: NostrEvent,
  rootId: string,
  profiles: ReadonlyMap<string, NostrProfile>
): NgitComment {
  const parent =
    event.kind === NOSTR_KIND.comment
      ? tagValue(event, 'e')
      : event.tags.findLast((tag) => tag[0] === 'e' && tag[3] !== 'mention')?.[1]
  return {
    id: event.id,
    author: authorName(event.pubkey, profiles),
    authorAvatarUrl: profiles.get(event.pubkey)?.picture ?? null,
    body: event.content,
    createdAt: new Date(event.created_at * 1000).toISOString(),
    ...(parent && parent !== rootId ? { replyToId: parent } : {})
  }
}

/** Folds a repository's events into its issues, pull requests and patch series, newest first. */
export function projectNostrWorkItems(
  repository: NostrRepository,
  events: readonly NostrEvent[],
  profiles: ReadonlyMap<string, NostrProfile> = new Map()
): ProjectedWorkItem[] {
  const authorOf = new Map(events.map((event) => [event.id, event.pubkey]))
  const deleted = new Set(
    events
      .filter((event) => event.kind === NOSTR_KIND.deletion)
      .flatMap((event) => tagValues(event, 'e').filter((id) => authorOf.get(id) === event.pubkey))
  )
  const live = events.filter((event) => !deleted.has(event.id))
  const relatedTo = new Map<string, NostrEvent[]>()
  for (const event of live) {
    for (const id of new Set(referencedIds(event))) {
      const related = relatedTo.get(id)
      if (related) {
        related.push(event)
      } else {
        relatedTo.set(id, [event])
      }
    }
  }
  // A pull request event that revises a patch series replaces it in the list.
  const superseded = new Set(
    live
      .filter((event) => event.kind === NOSTR_KIND.pullRequest)
      .flatMap((event) => tagValues(event, 'e').filter((id) => authorOf.get(id) === event.pubkey))
  )
  const repositoryUrl = repository.webUrl
  return live
    .filter((event) => isWorkItemRoot(event) && !superseded.has(event.id))
    .map((root): ProjectedWorkItem => {
      const related = relatedTo.get(root.id) ?? []
      const trusted = (event: NostrEvent): boolean =>
        event.pubkey === root.pubkey || repository.maintainers.includes(event.pubkey)
      const authorised = related.filter(trusted).toSorted(byNewest)
      const status = authorised.find((event) => STATUS_KINDS.includes(event.kind))
      const labelEvents = authorised.filter((event) => event.kind === NOSTR_KIND.label)
      const isIssue = root.kind === NOSTR_KIND.issue
      const isPatch = root.kind === NOSTR_KIND.patch
      const series = isPatch ? patchSeries(root, related, trusted) : []
      const update = authorised.find((event) => event.kind === NOSTR_KIND.pullRequestUpdate)
      const tip = isPatch ? series.at(-1) : (update ?? root)
      const headSha = isIssue || !tip ? undefined : tagValue(tip, isPatch ? 'commit' : 'c')
      const message = isPatch ? patchMessage(root.content) : null
      const comments = related
        .filter(
          (event) => event.kind === NOSTR_KIND.comment || event.kind === NOSTR_KIND.legacyReply
        )
        .toSorted((a, b) => a.created_at - b.created_at)
      const labels = [
        ...tagValues(root, 't'),
        ...labelEvents.flatMap((event) =>
          event.tags.filter((t) => t[0] === 'l' && t[2] === '#t').map((t) => t[1] ?? '')
        )
      ].filter((label) => label && !PATCH_MARKER_TAGS.has(label))
      const updatedAt = Math.max(
        root.created_at,
        ...[...authorised, ...comments, ...series].map((event) => event.created_at)
      )
      const branchName = tagValue(root, 'branch-name')
      const targetBranch = tagValue(update ?? root, 'target-branch')
      const nevent = neventEncode({
        id: root.id,
        relays: repository.relays.slice(0, 1),
        author: root.pubkey
      })
      return {
        authorPubkey: root.pubkey,
        body: message ? tagValue(root, 'description') || message.body : root.content,
        comments,
        commentProfiles: profiles,
        patches: series.map((patch) => ({
          id: patch.id,
          commit: tagValue(patch, 'commit'),
          subject: patchMessage(patch.content).subject,
          content: patch.content
        })),
        cloneUrls: [
          ...new Set(
            [update, root]
              .flatMap((event) =>
                event ? event.tags.filter((t) => t[0] === 'clone').flatMap((t) => t.slice(1)) : []
              )
              .concat(repository.cloneUrls)
          )
        ],
        item: {
          type: isIssue ? 'issue' : 'pr',
          number: nostrItemNumber(root.id),
          eventId: root.id,
          title:
            newestLabelValue(labelEvents, '#subject') ??
            (message ? message.subject || issueTitle(root) : issueTitle(root)),
          state: itemState(root, status),
          url: `${repositoryUrl}/${isIssue ? 'issues' : 'prs'}/${nevent}`,
          labels: [...new Set(labels)],
          createdAt: new Date(root.created_at * 1000).toISOString(),
          updatedAt: new Date(updatedAt * 1000).toISOString(),
          author: authorName(root.pubkey, profiles),
          authorAvatarUrl: profiles.get(root.pubkey)?.picture ?? null,
          commentCount: comments.length,
          ...(branchName ? { branchName } : {}),
          ...(targetBranch ? { baseRefName: targetBranch } : {}),
          ...(headSha ? { headSha } : {}),
          ...(isPatch ? { isPatch: true } : {})
        }
      }
    })
    .toSorted((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt))
}
