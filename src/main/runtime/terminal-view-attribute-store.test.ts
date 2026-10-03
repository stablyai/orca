import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { TerminalViewAttributes, TerminalViewRgb } from '../../shared/terminal-view-attributes'
import type { PtyOwnerRepoColorsByHost } from '../../shared/pty-owner-color-query-colors'
import {
  _resetTerminalViewAttributesForTest,
  getRepoTerminalViewerColorsByHost,
  getTerminalViewAttributes,
  getTerminalViewAttributesForScope,
  getTerminalViewColorQueryReplyColors,
  getTerminalViewerColors,
  refreshTerminalViewAttributesSeed,
  registerTerminalViewAttributesApplier,
  setRepoTerminalViewAttributes,
  setRepoTerminalViewerColorsListener,
  setTerminalViewAttributes,
  setTerminalViewAttributesSeedSource,
  setTerminalViewerColorsListener,
  type TerminalViewAttributesPush,
  type TerminalViewAttributesSeed
} from './terminal-view-attribute-store'

function attrs(foreground: TerminalViewRgb, background: TerminalViewRgb): TerminalViewAttributes {
  return {
    foreground,
    background,
    cursor: [1, 1, 1],
    ansi: Array.from({ length: 256 }, (_, i) => [i % 256, 0, 0] as TerminalViewRgb),
    colorSchemeMode: 'light',
    cursorStyle: 'block',
    cursorBlink: true
  }
}

const GLOBAL = attrs([46, 52, 52], [255, 255, 255])
const SOLARIZED = attrs([131, 148, 150], [0, 43, 54])
const local = (worktreeId: string | null) => ({ worktreeId, connectionId: null })

describe('terminal view attribute store scopes', () => {
  afterEach(() => {
    _resetTerminalViewAttributesForTest()
  })

  function seed(): void {
    setTerminalViewAttributes(GLOBAL)
    setRepoTerminalViewAttributes({ byHostId: { local: { repo1: SOLARIZED } } })
  }

  it.each([
    ['a local worktree id', 'repo1::/p'],
    ['a folder-kind repo instance id', 'repo1::/p::workspace:0f8b4c1e-7d2a-4b8e-9c3f-1a2b3c4d5e6f']
  ])('answers the repo snapshot for %s', (_label, worktreeId) => {
    seed()
    expect(getTerminalViewAttributesForScope(local(worktreeId))).toBe(SOLARIZED)
  })

  it.each([
    ['an unthemed repo', local('repo2::/q')],
    ['a folder workspace', local('folder:abc')],
    ['the floating terminal', local(FLOATING_TERMINAL_WORKTREE_ID)],
    ['an SSH PTY of a themed repo id', { worktreeId: 'repo1::/p', connectionId: 'target-1' }],
    ['an unknown worktree', local(null)],
    ['no scope', null]
  ])('falls back to the global snapshot for %s', (_label, scope) => {
    seed()
    expect(getTerminalViewAttributesForScope(scope)).toBe(GLOBAL)
  })

  it('stays silent before the first global push even with repo entries for other repos', () => {
    setRepoTerminalViewAttributes({ byHostId: { local: { repo1: SOLARIZED } } })
    expect(getTerminalViewAttributesForScope(local('repo2::/q'))).toBeNull()
    expect(getTerminalViewAttributesForScope(local('repo1::/p'))).toBe(SOLARIZED)
  })

  it('does not run appliers for an identical repo re-push', () => {
    seed()
    const applier = vi.fn()
    registerTerminalViewAttributesApplier(applier)
    setRepoTerminalViewAttributes({
      byHostId: { local: { repo1: attrs([131, 148, 150], [0, 43, 54]) } }
    })
    expect(applier).not.toHaveBeenCalled()
  })

  it('runs appliers once for a changed repo push, including removal', () => {
    seed()
    const applier = vi.fn()
    registerTerminalViewAttributesApplier(applier)
    setRepoTerminalViewAttributes({ byHostId: { local: { repo1: attrs([1, 2, 3], [0, 43, 54]) } } })
    expect(applier).toHaveBeenCalledTimes(1)
    setRepoTerminalViewAttributes({ byHostId: {} })
    expect(applier).toHaveBeenCalledTimes(2)
    expect(getTerminalViewAttributesForScope(local('repo1::/p'))).toBe(GLOBAL)
  })

  it('tells appliers whether a push re-themed or only taught main the base, with the base before', () => {
    const pushes: {
      kind: TerminalViewAttributesPush['kind']
      before: TerminalViewAttributes | null
    }[] = []
    registerTerminalViewAttributesApplier((push) =>
      pushes.push({ kind: push.kind, before: push.resolveBefore(local('repo1::/p')) })
    )
    setTerminalViewAttributes(GLOBAL)
    setTerminalViewAttributes(attrs([46, 52, 52], [255, 255, 255]))
    // First repo map after a restart: the themed PTY's pane painted repo1's theme all along.
    setRepoTerminalViewAttributes({ byHostId: { local: { repo1: SOLARIZED } } })
    const retheme = attrs([1, 2, 3], [0, 43, 54])
    setRepoTerminalViewAttributes({ byHostId: { local: { repo1: retheme } } })
    setRepoTerminalViewAttributes({ byHostId: {} })
    expect(pushes).toEqual([
      { kind: 'base-learned', before: null },
      { kind: 'base-learned', before: GLOBAL },
      { kind: 'theme-change', before: SOLARIZED },
      { kind: 'theme-change', before: retheme }
    ])
  })

  it('formats reply colors from the scoped snapshot', () => {
    seed()
    expect(getTerminalViewColorQueryReplyColors(local('repo1::/p'))).toEqual({
      foreground: '#839496',
      background: '#002b36'
    })
    expect(getTerminalViewColorQueryReplyColors()).toEqual({
      foreground: '#2e3434',
      background: '#ffffff'
    })
  })
})

describe('attributes pre-loaded from persisted settings and projects', () => {
  afterEach(() => {
    _resetTerminalViewAttributesForTest()
  })

  const SEED_SOLARIZED = { foreground: '#839496', background: '#002b36' }
  const SEED_TOKYO = { foreground: '#c0caf5', background: '#1a1b26' }
  const TOKYO = attrs([0xc0, 0xca, 0xf5], [0x1a, 0x1b, 0x26])
  const seedOf = (
    byRepoId: Record<string, TerminalViewAttributes>
  ): TerminalViewAttributesSeed => ({
    global: attrs([46, 52, 52], [255, 255, 255]),
    byHostId: { local: byRepoId }
  })

  it('answers OSC 4/12/?996n sources for themed and unthemed local projects before any renderer push', () => {
    setTerminalViewAttributesSeedSource(() => seedOf({ repo1: SOLARIZED }))

    expect(getTerminalViewAttributesForScope(local('repo1::/p'))).toBe(SOLARIZED)
    expect(getTerminalViewAttributesForScope(local('repo2::/q'))).toEqual(GLOBAL)
    expect(getTerminalViewAttributesForScope(local('folder:abc'))).toEqual(GLOBAL)
    expect(getTerminalViewAttributesForScope(local(FLOATING_TERMINAL_WORKTREE_ID))).toEqual(GLOBAL)
    expect(
      getTerminalViewAttributesForScope({ worktreeId: 'repo1::/p', connectionId: 'ssh-1' })
    ).toEqual(GLOBAL)
    expect(getTerminalViewAttributesForScope(null)).toEqual(GLOBAL)
    expect(getTerminalViewerColors(local('repo1::/p'))).toEqual(SEED_SOLARIZED)
    expect(getTerminalViewerColors(local('repo2::/q'))).toEqual({
      foreground: '#2e3434',
      background: '#ffffff'
    })
    expect(getRepoTerminalViewerColorsByHost()).toEqual({ local: { repo1: SEED_SOLARIZED } })
    expect(getTerminalViewAttributes()).toBeNull()
  })

  it('stays silent without a seed source (a host with no window)', () => {
    setTerminalViewAttributesSeedSource(null)
    expect(getTerminalViewAttributesForScope(local('repo1::/p'))).toBeNull()
    expect(getRepoTerminalViewerColorsByHost()).toBeNull()
  })

  it('treats the renderer publishing the seeded values as a no-op: no appliers, no owner notify', () => {
    setTerminalViewAttributesSeedSource(() => seedOf({ repo1: SOLARIZED }))
    const applier = vi.fn()
    registerTerminalViewAttributesApplier(applier)
    const viewerPushes: unknown[] = []
    const repoPushes: unknown[] = []
    setTerminalViewerColorsListener((colors) => viewerPushes.push(colors))
    setRepoTerminalViewerColorsListener((byHost) => repoPushes.push(byHost))

    setTerminalViewAttributes(attrs([46, 52, 52], [255, 255, 255]))
    setRepoTerminalViewAttributes({
      byHostId: { local: { repo1: attrs([131, 148, 150], [0, 43, 54]) } }
    })

    expect(applier).not.toHaveBeenCalled()
    expect(viewerPushes).toEqual([])
    expect(repoPushes).toEqual([])
    // The renderer's word is adopted: a later real change is a theme change.
    const pushes: TerminalViewAttributesPush['kind'][] = []
    registerTerminalViewAttributesApplier((push) => pushes.push(push.kind))
    setTerminalViewAttributes(attrs([1, 2, 3], [255, 255, 255]))
    setRepoTerminalViewAttributes({ byHostId: {} })
    expect(pushes).toEqual(['theme-change', 'theme-change'])
  })

  it('treats a renderer publish that differs from the seed as base-learned, not a theme change', () => {
    // E.g. main and the renderer disagree on the OS appearance: the seed was a guess, the
    // renderer's publish is what the panes painted all along.
    setTerminalViewAttributesSeedSource(() => seedOf({ repo1: SOLARIZED }))
    const pushes: {
      kind: TerminalViewAttributesPush['kind']
      before: TerminalViewAttributes | null
    }[] = []
    registerTerminalViewAttributesApplier((push) =>
      pushes.push({ kind: push.kind, before: push.resolveBefore(local('repo1::/p')) })
    )

    setTerminalViewAttributes(attrs([0, 0, 0], [0x28, 0x2c, 0x34]))
    setRepoTerminalViewAttributes({ byHostId: { local: { repo1: TOKYO } } })

    expect(pushes).toEqual([
      { kind: 'base-learned', before: SOLARIZED },
      { kind: 'base-learned', before: SOLARIZED }
    ])
    expect(getTerminalViewAttributesForScope(local('repo1::/p'))).toBe(TOKYO)
  })

  it('answers from the renderer map, not the seed, once the map is known even where it omits a project', () => {
    setTerminalViewAttributesSeedSource(() => seedOf({ repo1: SOLARIZED }))
    setTerminalViewAttributes(attrs([46, 52, 52], [255, 255, 255]))

    setRepoTerminalViewAttributes({ byHostId: {} })

    expect(getTerminalViewAttributesForScope(local('repo1::/p'))).toEqual(GLOBAL)
    expect(getTerminalViewerColors(local('repo1::/p'))?.background).toBe('#ffffff')
    expect(getRepoTerminalViewerColorsByHost()).toEqual({})
  })

  it('tells the owners about the seed, about seed refreshes, and not about an equal renderer map', () => {
    const published: PtyOwnerRepoColorsByHost[] = []
    setRepoTerminalViewerColorsListener((byHost) => published.push(byHost))
    let seed = seedOf({ repo1: SOLARIZED })
    setTerminalViewAttributesSeedSource(() => seed)
    refreshTerminalViewAttributesSeed()
    seed = seedOf({ repo1: TOKYO })
    refreshTerminalViewAttributesSeed()
    setRepoTerminalViewAttributes({
      byHostId: { local: { repo1: attrs([0xc0, 0xca, 0xf5], [0x1a, 0x1b, 0x26]) } }
    })
    // Once the renderer's map is known a seed refresh changes nothing the owners hear.
    seed = seedOf({ repo1: SOLARIZED })
    refreshTerminalViewAttributesSeed()

    expect(published).toEqual([
      { local: { repo1: SEED_SOLARIZED } },
      { local: { repo1: SEED_TOKYO } }
    ])
  })

  it('stops reading the seed source once the renderer has published both snapshots', () => {
    const source = vi.fn(() => seedOf({ repo1: SOLARIZED }))
    setTerminalViewAttributesSeedSource(source)
    setTerminalViewAttributes(GLOBAL)
    refreshTerminalViewAttributesSeed()
    expect(source).toHaveBeenCalledTimes(2)

    setRepoTerminalViewAttributes({ byHostId: { local: { repo1: SOLARIZED } } })
    refreshTerminalViewAttributesSeed()
    refreshTerminalViewAttributesSeed()

    expect(source).toHaveBeenCalledTimes(2)
  })

  it('keeps the last seed when the source is briefly unavailable', () => {
    let seed: TerminalViewAttributesSeed | null = seedOf({ repo1: SOLARIZED })
    setTerminalViewAttributesSeedSource(() => seed)
    const published: PtyOwnerRepoColorsByHost[] = []
    setRepoTerminalViewerColorsListener((byHost) => published.push(byHost))

    seed = null
    refreshTerminalViewAttributesSeed()

    expect(getTerminalViewAttributesForScope(local('repo1::/p'))).toBe(SOLARIZED)
    expect(getRepoTerminalViewerColorsByHost()).toEqual({ local: { repo1: SEED_SOLARIZED } })
    expect(published).toEqual([])
  })

  it('re-seeds as a theme change that remembers what each PTY answered before', () => {
    let seed = seedOf({ repo1: SOLARIZED })
    setTerminalViewAttributesSeedSource(() => seed)
    const pushes: {
      kind: TerminalViewAttributesPush['kind']
      before: TerminalViewAttributes | null
    }[] = []
    registerTerminalViewAttributesApplier((push) =>
      pushes.push({ kind: push.kind, before: push.resolveBefore(local('repo1::/p')) })
    )

    refreshTerminalViewAttributesSeed()
    seed = seedOf({ repo1: TOKYO })
    refreshTerminalViewAttributesSeed()

    expect(pushes).toEqual([{ kind: 'theme-change', before: SOLARIZED }])
    expect(getTerminalViewAttributesForScope(local('repo1::/p'))).toBe(TOKYO)
  })
})

describe('project themes keyed by execution host', () => {
  afterEach(() => {
    _resetTerminalViewAttributesForTest()
  })

  const TOKYO = attrs([0xc0, 0xca, 0xf5], [0x1a, 0x1b, 0x26])
  const onSsh = (worktreeId: string | null, connectionId = 'target-1') => ({
    worktreeId,
    connectionId
  })

  it('answers a local and an SSH PTY of the SAME repo id each from its own host', () => {
    setTerminalViewAttributes(GLOBAL)
    setRepoTerminalViewAttributes({
      byHostId: { local: { repo1: SOLARIZED }, 'ssh:target-1': { repo1: TOKYO } }
    })

    expect(getTerminalViewAttributesForScope(local('repo1::/p'))).toBe(SOLARIZED)
    expect(getTerminalViewAttributesForScope(onSsh('repo1::/remote/p'))).toBe(TOKYO)
    // Reconnect paths spell the connection as its execution host id; both name target-1.
    expect(getTerminalViewAttributesForScope(onSsh('repo1::/remote/p', 'ssh:target-1'))).toBe(TOKYO)
    expect(getTerminalViewColorQueryReplyColors(onSsh('repo1::/remote/p'))).toEqual({
      foreground: '#c0caf5',
      background: '#1a1b26'
    })
  })

  it.each([
    ['a host with no themed project', onSsh('repo1::/p', 'target-2')],
    ['an unthemed repo on a themed host', onSsh('repo2::/q')],
    ['a folder workspace on a themed host', onSsh('folder:abc')],
    ['the floating terminal on a themed host', onSsh(FLOATING_TERMINAL_WORKTREE_ID)]
  ])('falls back to the global snapshot for %s', (_label, scope) => {
    setTerminalViewAttributes(GLOBAL)
    setRepoTerminalViewAttributes({ byHostId: { 'ssh:target-1': { repo1: TOKYO } } })
    expect(getTerminalViewAttributesForScope(scope)).toBe(GLOBAL)
  })

  it("tells appliers the old base per host, so only the changed host's PTYs re-theme", () => {
    setTerminalViewAttributes(GLOBAL)
    setRepoTerminalViewAttributes({
      byHostId: { local: { repo1: SOLARIZED }, 'ssh:target-1': { repo1: SOLARIZED } }
    })
    const pushes: { kind: TerminalViewAttributesPush['kind']; before: unknown; after: unknown }[] =
      []
    registerTerminalViewAttributesApplier((push) => {
      for (const scope of [local('repo1::/p'), onSsh('repo1::/p')]) {
        pushes.push({
          kind: push.kind,
          before: push.resolveBefore(scope),
          after: getTerminalViewAttributesForScope(scope)
        })
      }
    })

    setRepoTerminalViewAttributes({
      byHostId: { local: { repo1: SOLARIZED }, 'ssh:target-1': { repo1: TOKYO } }
    })

    expect(pushes).toEqual([
      { kind: 'theme-change', before: SOLARIZED, after: SOLARIZED },
      { kind: 'theme-change', before: SOLARIZED, after: TOKYO }
    ])
  })

  it('reports project colours to the owners by host, and an empty host as no host at all', () => {
    const published: PtyOwnerRepoColorsByHost[] = []
    setRepoTerminalViewerColorsListener((byHost) => published.push(byHost))
    setTerminalViewAttributesSeedSource(() => ({
      global: GLOBAL,
      byHostId: { local: {}, 'ssh:target-1': { repo1: TOKYO } }
    }))
    expect(getTerminalViewerColors(onSsh('repo1::/p'))).toEqual({
      foreground: '#c0caf5',
      background: '#1a1b26'
    })
    const applier = vi.fn()
    registerTerminalViewAttributesApplier(applier)

    // The renderer confirming the seed, with the empty host spelled by absence: a no-op.
    setRepoTerminalViewAttributes({ byHostId: { 'ssh:target-1': { repo1: TOKYO } } })
    // Every themed project cleared, on every host.
    setRepoTerminalViewAttributes({ byHostId: {} })

    expect(applier).toHaveBeenCalledTimes(1)
    expect(published).toEqual([
      { 'ssh:target-1': { repo1: { foreground: '#c0caf5', background: '#1a1b26' } } },
      {}
    ])
    expect(getTerminalViewAttributesForScope(onSsh('repo1::/p'))).toBe(GLOBAL)
  })
})
