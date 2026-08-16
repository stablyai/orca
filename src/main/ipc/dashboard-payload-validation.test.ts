import { describe, expect, it, vi } from 'vitest'
import type { DashboardSnapshot } from '../../shared/dashboard-snapshot'
import type * as RepoIconModule from '../../shared/repo-icon'

// Counts real sanitizer entries so the icon cache is proven by decode count
// rather than by wall clock, which is unfalsifiable on a loaded CI box.
const sanitizeRepoIconCalls = vi.hoisted(() => vi.fn())
vi.mock('../../shared/repo-icon', async (importOriginal) => {
  const actual = await importOriginal<typeof RepoIconModule>()
  return {
    ...actual,
    sanitizeRepoIcon: (value: unknown) => {
      sanitizeRepoIconCalls(value)
      return actual.sanitizeRepoIcon(value)
    }
  }
})

import {
  admitDashboardSnapshot,
  isDashboardRevealAgentArgs,
  isDashboardSpawnAgentArgs,
  isDashboardSnapshot
} from './dashboard-payload-validation'

const SNAPSHOT = {
  generatedAt: 1_700_000_000_000,
  cards: [
    {
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      agentType: 'codex',
      bucket: 'attention',
      dotState: 'waiting',
      task: 'Review the dashboard',
      lastUserMessage: 'Please review this',
      lastAgentMessage: 'I need a decision.',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      parentPaneKey: 'tab-parent:leaf-parent',
      parentWorktreeId: 'parent-worktree-1',
      repoName: 'Orca',
      worktreeName: 'Dashboard',
      hostKind: 'ssh',
      executionHostId: 'ssh:build-box',
      hostLabel: 'Build box',
      workspaceKind: 'worktree',
      workspaceStatusId: 'in-review',
      workspaceStatusLabel: 'In review',
      workspaceStatusColor: 'emerald',
      hasReview: true,
      review: { number: 11012, state: 'open' },
      subagents: [{ id: 'child-1', name: 'Review loop', dotState: 'working' }],
      startedAt: 1_699_999_000_000,
      finishedAt: null,
      stateChangedAt: 1_699_999_500_000,
      unseen: true,
      askSummary: '{"question":"Proceed?"}'
    }
  ],
  workspaces: [
    {
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      repoName: 'Orca',
      worktreeName: 'Dashboard',
      parentWorktreeId: 'parent-worktree-1',
      hostKind: 'ssh',
      executionHostId: 'ssh:build-box',
      hostLabel: 'Build box',
      workspaceKind: 'worktree',
      workspaceStatusId: 'in-review',
      workspaceStatusLabel: 'In review',
      workspaceStatusColor: 'emerald',
      hasReview: true,
      review: { number: 11012, state: 'open' }
    }
  ],
  showIdle: false,
  filterOptions: {
    projects: [{ id: 'repo-1', label: 'Orca' }],
    workspaceStatuses: [{ id: 'in-review', label: 'In review', color: 'emerald' }]
  }
} satisfies DashboardSnapshot

/** A real PNG header plus `bodyBytes` of filler, so sanitizing actually decodes. */
function imageIconSrc(bodyBytes: number, withWhitespace = false): string {
  const header = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 64, 0, 0, 0, 64, 8, 6, 0,
    0, 0
  ])
  const body = Buffer.concat([header, Buffer.alloc(bodyBytes, bodyBytes % 251)]).toString('base64')
  // The sanitizer's base64 pattern admits whitespace, so a real src can hold it.
  return `data:image/png;base64,${withWhitespace ? `${body.slice(0, 20)} ${body.slice(20)}` : body}`
}

describe('dashboard payload validation', () => {
  it('accepts a complete dashboard snapshot', () => {
    expect(isDashboardSnapshot(SNAPSHOT)).toBe(true)
  })

  it('rejects malformed or unbounded snapshot fields', () => {
    expect(isDashboardSnapshot({ ...SNAPSHOT, generatedAt: Number.NaN })).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], bucket: 'unexpected' }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], lastAgentMessage: 'x'.repeat(8_001) }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], review: { number: 0, state: 'open' } }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], subagents: [{ id: '', name: 'bad', dotState: 'idle' }] }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], hostKind: 'satellite' }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], executionHostId: 'build-box' }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], executionHostId: `ssh:${'x'.repeat(4_097)}` }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], hostLabel: 'x'.repeat(1_025) }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], parentWorktreeId: 'x'.repeat(4_097) }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], workspaceKind: 'repository' }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], parentPaneKey: 'x'.repeat(4_097) }]
      })
    ).toBe(false)
  })

  it('accepts repo icons a pop-out can safely render, and rejects the rest', () => {
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        repoIconsByRepoId: {
          'repo-1': { type: 'lucide', name: 'Rocket' },
          'repo-2': null,
          'repo-3': {
            type: 'image',
            src: 'https://github.com/anthropics.png?size=64',
            source: 'github'
          }
        }
      })
    ).toBe(true)
    // Absent entirely: a pop-out on older code still gets its snapshot.
    expect(isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: undefined })).toBe(true)

    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        repoIconsByRepoId: {
          'repo-1': { type: 'image', src: 'javascript:alert(1)', source: 'file' }
        }
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        repoIconsByRepoId: { 'repo-1': { type: 'nonsense' } }
      })
    ).toBe(false)
    expect(isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: [] })).toBe(false)
  })

  it('accepts bounded filter options independently of cards', () => {
    expect(isDashboardSnapshot({ ...SNAPSHOT, cards: [] })).toBe(true)
    expect(isDashboardSnapshot({ ...SNAPSHOT, filterOptions: undefined })).toBe(true)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        filterOptions: {
          ...SNAPSHOT.filterOptions,
          projects: [{ id: '', label: 'Invalid' }]
        }
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        filterOptions: {
          ...SNAPSHOT.filterOptions,
          workspaceStatuses: [{ id: 'todo', label: 'x'.repeat(1_025) }]
        }
      })
    ).toBe(false)
  })

  it('validates bounded map workspace metadata independently of cards', () => {
    expect(isDashboardSnapshot({ ...SNAPSHOT, cards: [] })).toBe(true)
    expect(isDashboardSnapshot({ ...SNAPSHOT, workspaces: undefined })).toBe(true)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        workspaces: [{ ...SNAPSHOT.workspaces[0], executionHostId: 'build-box' }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        workspaces: [{ ...SNAPSHOT.workspaces[0], worktreeName: 'x'.repeat(1_025) }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        workspaces: [{ ...SNAPSHOT.workspaces[0], hostLabel: 'x'.repeat(1_025) }]
      })
    ).toBe(false)
  })

  it('validates bounded launch choices and spawn requests', () => {
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        launchableAgentsByWorktreeId: { 'worktree-1': ['codex', 'claude'] }
      })
    ).toBe(true)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        launchableAgentsByWorktreeId: { 'worktree-1': ['not-an-agent'] }
      })
    ).toBe(false)
    expect(isDashboardSnapshot({ ...SNAPSHOT, launchableAgentsByWorktreeId: [] })).toBe(false)

    expect(isDashboardSpawnAgentArgs({ worktreeId: 'worktree-1', agent: 'codex' })).toBe(true)
    expect(isDashboardSpawnAgentArgs({ worktreeId: '', agent: 'codex' })).toBe(false)
    expect(isDashboardSpawnAgentArgs({ worktreeId: 'worktree-1', agent: 'unknown' })).toBe(false)
  })

  it('bounds the conversation name', () => {
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], conversationName: 'Sparse-checkout parser' }]
      })
    ).toBe(true)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], conversationName: 'x'.repeat(1_025) }]
      })
    ).toBe(false)
  })

  it('validates the preview terminal input profile', () => {
    const terminalInput = {
      hostPlatform: 'win32',
      localWindowsConpty: true,
      osRelease: '10.0.22631',
      windowsShiftEnterEncoding: 'alt-enter',
      windowsInputRecordPasteNewline: 'alt-enter',
      ctrlEnterCsiU: false,
      kittyKeyboardAdvertised: false
    }
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], terminalInput }]
      })
    ).toBe(true)
    for (const invalid of [
      { ...terminalInput, hostPlatform: 'windows' },
      { ...terminalInput, localWindowsConpty: 'true' },
      { ...terminalInput, osRelease: 'x'.repeat(1_025) },
      { ...terminalInput, windowsShiftEnterEncoding: 'enter' },
      { ...terminalInput, forceBracketedMultilineTextPaste: false },
      { ...terminalInput, windowsInputRecordPasteNewline: 'enter' },
      { ...terminalInput, ctrlEnterCsiU: 'true' },
      { ...terminalInput, kittyKeyboardAdvertised: 1 }
    ]) {
      expect(
        isDashboardSnapshot({
          ...SNAPSHOT,
          cards: [{ ...SNAPSHOT.cards[0], terminalInput: invalid }]
        })
      ).toBe(false)
    }
  })

  // Why: terminalInput is per-card, so a host profile this validator does not
  // know must cost that preview its card, never the whole board.
  it('drops only the card whose terminal input profile is unusable', () => {
    const good = SNAPSHOT.cards[0]
    const bad = {
      ...good,
      paneKey: 'tab-2:leaf-2',
      terminalInput: {
        hostPlatform: 'plan9',
        localWindowsConpty: false,
        windowsShiftEnterEncoding: 'csi-u',
        ctrlEnterCsiU: false,
        kittyKeyboardAdvertised: true
      }
    }

    const admitted = admitDashboardSnapshot({ ...SNAPSHOT, cards: [good, bad] })

    expect(admitted?.droppedCardCount).toBe(1)
    expect(admitted?.snapshot.cards.map((card) => card.paneKey)).toEqual(['tab-1:leaf-1'])
  })

  // Why: the pop-out replays the last accepted snapshot, so rejecting the whole
  // board over one card froze every other agent's status until it was renamed.
  describe('admitDashboardSnapshot', () => {
    it('drops only the offending card and keeps the rest of the board', () => {
      const good = SNAPSHOT.cards[0]
      const bad = { ...good, paneKey: 'tab-2:leaf-2', conversationName: 'x'.repeat(1_025) }

      const admitted = admitDashboardSnapshot({ ...SNAPSHOT, cards: [good, bad] })

      expect(admitted?.droppedCardCount).toBe(1)
      expect(admitted?.snapshot.cards.map((card) => card.paneKey)).toEqual(['tab-1:leaf-1'])
    })

    it('drops only malformed optional workspace metadata', () => {
      const admitted = admitDashboardSnapshot({
        ...SNAPSHOT,
        workspaces: [
          SNAPSHOT.workspaces[0],
          { ...SNAPSHOT.workspaces[0], worktreeId: '', worktreeName: 'Invalid' }
        ]
      })

      expect(admitted?.droppedCardCount).toBe(0)
      expect(admitted?.snapshot.workspaces).toEqual([SNAPSHOT.workspaces[0]])
    })

    it('reports nothing dropped for a fully valid snapshot', () => {
      const admitted = admitDashboardSnapshot(SNAPSHOT)

      expect(admitted?.droppedCardCount).toBe(0)
      expect(admitted?.snapshot.cards).toHaveLength(1)
    })

    it('drops a card that fails only the search-board fields', () => {
      const good = SNAPSHOT.cards[0]
      const badReview = { ...good, paneKey: 'p2', review: { number: 0, state: 'open' } }
      const badSubagent = {
        ...good,
        paneKey: 'p3',
        subagents: [{ id: '', name: 'x', dotState: 'idle' }]
      }
      const badBucket = { ...good, paneKey: 'p4', bucket: 'archived' }

      const admitted = admitDashboardSnapshot({
        ...SNAPSHOT,
        cards: [good, badReview, badSubagent, badBucket]
      })

      expect(admitted?.droppedCardCount).toBe(3)
      expect(admitted?.snapshot.cards.map((card) => card.paneKey)).toEqual(['tab-1:leaf-1'])
    })

    it('keeps a done-bucket card the search board produces', () => {
      const admitted = admitDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], bucket: 'done', dotState: 'done' }]
      })

      expect(admitted?.droppedCardCount).toBe(0)
    })

    it('still rejects a snapshot whose own shape is unusable', () => {
      expect(admitDashboardSnapshot({ ...SNAPSHOT, generatedAt: Number.NaN })).toBeNull()
      expect(admitDashboardSnapshot({ ...SNAPSHOT, cards: 'nope' })).toBeNull()
      expect(admitDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: [] })).toBeNull()
      // Why: showIdle and filterOptions describe the frame, not one card, so a
      // bad value there has no card to drop and must fail the whole snapshot.
      expect(admitDashboardSnapshot({ ...SNAPSHOT, showIdle: 'yes' })).toBeNull()
      expect(
        admitDashboardSnapshot({
          ...SNAPSHOT,
          filterOptions: { ...SNAPSHOT.filterOptions, projects: [{ id: '', label: 'Invalid' }] }
        })
      ).toBeNull()
    })

    it('mirrors isDashboardSnapshot on every snapshot-level rejection', () => {
      const cases: unknown[] = [
        { ...SNAPSHOT, generatedAt: Number.NaN },
        { ...SNAPSHOT, cards: 'nope' },
        { ...SNAPSHOT, repoIconsByRepoId: [] },
        { ...SNAPSHOT, showIdle: 'yes' },
        { ...SNAPSHOT, filterOptions: { projects: [], workspaceStatuses: 'nope' } },
        null,
        []
      ]
      for (const value of cases) {
        expect(isDashboardSnapshot(value)).toBe(false)
        expect(admitDashboardSnapshot(value)).toBeNull()
      }
    })
  })

  // Why: sanitizing an image icon decodes the whole payload to read a 24-byte
  // header, and the renderer republishes the same icons every 250 ms.
  it('validates a repeated image icon without re-decoding it every publish', () => {
    const src = imageIconSrc(256 * 1024)
    const snapshot = {
      ...SNAPSHOT,
      repoIconsByRepoId: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `repo-${index}`,
          { type: 'image', src, source: 'upload' }
        ])
      )
    }
    sanitizeRepoIconCalls.mockClear()

    for (let publish = 0; publish < 20; publish += 1) {
      expect(isDashboardSnapshot(snapshot)).toBe(true)
    }

    // 10 repos x 20 publishes = 200 icon checks against ONE decode.
    expect(sanitizeRepoIconCalls).toHaveBeenCalledTimes(1)
  })

  it('re-decodes when the icon payload or its source actually changes', () => {
    const first = { type: 'image', src: imageIconSrc(1_024), source: 'upload' }
    const second = { type: 'image', src: imageIconSrc(2_048), source: 'upload' }
    // Same bytes, different source: `source` picks which src pattern is legal,
    // so it must not collide with the first entry's cached verdict.
    const rebranded = { ...first, source: 'file' }
    sanitizeRepoIconCalls.mockClear()

    for (const icon of [first, first, second, second, rebranded, rebranded]) {
      isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: { 'repo-1': icon } })
    }

    expect(sanitizeRepoIconCalls).toHaveBeenCalledTimes(3)
  })

  it('caches a rejection too, so a bad icon cannot be re-decoded every publish', () => {
    const icon = {
      type: 'image',
      src: `${imageIconSrc(1_024)}`.replace('png', 'gif'),
      source: 'upload'
    }
    sanitizeRepoIconCalls.mockClear()

    for (let publish = 0; publish < 5; publish += 1) {
      expect(isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: { 'repo-1': icon } })).toBe(
        false
      )
    }

    expect(sanitizeRepoIconCalls).toHaveBeenCalledTimes(1)
  })

  it('does not let a split of one icon key inherit another icon verdict', () => {
    // A valid base64 src may contain whitespace, so `source` and `src` must not
    // be joined ambiguously: this pair concatenates identically.
    const accepted = { type: 'image', src: imageIconSrc(1_024, true), source: 'upload' }
    const joined = `upload ${accepted.src}`
    const splitAt = joined.indexOf(' ', 'upload '.length)
    const forged = {
      type: 'image',
      source: joined.slice(0, splitAt),
      src: joined.slice(splitAt + 1)
    }
    sanitizeRepoIconCalls.mockClear()

    expect(isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: { 'repo-1': accepted } })).toBe(
      true
    )
    // `forged.source` is not a legal RepoIconImageSource, so it must be rejected
    // no matter what the accepted icon left in the cache.
    expect(isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: { 'repo-1': forged } })).toBe(
      false
    )
    expect(sanitizeRepoIconCalls).toHaveBeenCalledTimes(2)
  })

  it('does not let a cached image verdict answer for a non-image icon', () => {
    const emoji = { type: 'emoji', emoji: '🦑' }
    sanitizeRepoIconCalls.mockClear()

    for (let publish = 0; publish < 3; publish += 1) {
      expect(isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: { 'repo-1': emoji } })).toBe(
        true
      )
    }

    // Cheap branches bypass the cache entirely rather than sharing its keyspace.
    expect(sanitizeRepoIconCalls).toHaveBeenCalledTimes(3)
  })

  it('requires complete bounded reveal routing', () => {
    expect(
      isDashboardRevealAgentArgs({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        executionHostId: 'runtime:env-1',
        tabId: 'tab-1',
        leafId: null
      })
    ).toBe(true)
    expect(
      isDashboardRevealAgentArgs({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        executionHostId: 'runtime:',
        tabId: 'tab-1',
        leafId: null
      })
    ).toBe(false)
    expect(
      isDashboardRevealAgentArgs({ repoId: 'repo-1', worktreeId: 'worktree-1', tabId: '' })
    ).toBe(false)
  })
})
