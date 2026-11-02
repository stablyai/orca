// Where the window shows a stored session differently once the shared Loader has rewritten it,
// each with the Loader rule that causes it. Shared by every parity test that compares a window
// built from the Loader's result with the window restored from disk.

export const GIT = 'repo-1::/Users/dev/orca'
const terminal = (tabId: string) =>
  ['phone and CLI title', 'panes', 'focused pane', 'reattaches'].map(
    (field) => `${GIT} terminal ${tabId} ${field}`
  )

export type KnownDifference = {
  fixture: string
  /** The Loader rule that makes the window show something else. */
  rule: string
  /** View paths that differ; see `projectStartupWindowView`. */
  paths: string[]
}

/** Differences to fix. Entries may only be removed: fix the rule, then delete its entry. */
export const KNOWN_DIFFERENCES: readonly KnownDifference[] = [
  {
    fixture: 'row without a tab-bar entry or a terminal',
    rule: 'ghost tab: the Loader gives every row a tab-bar entry; the window adopts only rows it can reattach',
    paths: [`${GIT} group 0 tabs`, `${GIT} tab tab-b`, ...terminal('tab-b')]
  }
]

export type AcceptedDifference = Omit<KnownDifference, 'paths'> & {
  reason: string
  /** Each differing view path with its stored and normalized values; absent means not shown. */
  values: Record<string, { stored?: unknown; normalized?: unknown }>
}

/** Differences that are not bugs: the user sees the same thing, or the window is the outlier. */
export const ACCEPTED_DIFFERENCES: readonly AcceptedDifference[] = [
  {
    fixture: 'row terminal differs from its focused pane’s',
    rule: 'row.ptyId rewrite: the Loader sets the row terminal to its focused pane’s, which changes what the tab reattaches',
    reason: 'the pane’s own terminal binding wins on mount, so the user sees the same terminal',
    values: { [`${GIT} terminal tab-a reattaches`]: { stored: 'pty-stale', normalized: 'pty-a' } }
  },
  {
    fixture: 'row with no terminal while its pane has one',
    rule: 'row.ptyId rewrite: the Loader sets the row terminal to its focused pane’s, which changes what the tab reattaches',
    reason: 'the pane’s own terminal binding wins on mount, so the user sees the same terminal',
    values: { [`${GIT} terminal tab-a reattaches`]: { stored: null, normalized: 'pty-a' } }
  },
  {
    fixture: 'legacy surface tombstone on a pane still showing its terminal',
    rule: 'tombstones: the Loader closes a pane a legacy surface tombstone names; the window ignores the tombstone and shows the pane',
    reason: 'the window is the outlier: main already retires panes these tombstones name',
    values: {
      [`${GIT} group 0 tabs`]: { stored: ['tab-a', 'tab-b'], normalized: ['tab-a'] },
      [`${GIT} tab tab-b`]: {
        stored: { kind: 'terminal', shows: 'tab-b', group: 0, label: 'Terminal 2' }
      },
      [`${GIT} terminal tab-b phone and CLI title`]: { stored: 'Terminal 2' },
      [`${GIT} terminal tab-b panes`]: { stored: { pane: 'pty-b' } },
      [`${GIT} terminal tab-b focused pane`]: { stored: 'root' },
      [`${GIT} terminal tab-b reattaches`]: { stored: 'pty-b' }
    }
  },
  {
    fixture: 'tab-bar label differing from the row title',
    rule: 'label over title: the Loader writes the tab-bar label into the row title',
    reason:
      'the desktop tab shows the label, which is unchanged; only phones and the CLI show the row title',
    values: {
      [`${GIT} terminal tab-a phone and CLI title`]: { stored: 'Terminal 1', normalized: 'vim' }
    }
  }
]
