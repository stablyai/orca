export const NOSTR_KIND = {
  profile: 0,
  legacyReply: 1,
  deletion: 5,
  comment: 1111,
  patch: 1617,
  pullRequest: 1618,
  pullRequestUpdate: 1619,
  issue: 1621,
  statusOpen: 1630,
  statusApplied: 1631,
  statusClosed: 1632,
  statusDraft: 1633,
  label: 1985,
  repositoryAnnouncement: 30617
} as const

export const STATUS_KINDS: readonly number[] = [
  NOSTR_KIND.statusOpen,
  NOSTR_KIND.statusApplied,
  NOSTR_KIND.statusClosed,
  NOSTR_KIND.statusDraft
]
