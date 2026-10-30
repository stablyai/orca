import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerSnapshotResult } from '../../shared/runtime-types'
import { ComputerTreeBaselines, diffComputerTreeText } from './computer-snapshot-tree-diff'

// Trimmed from a macOS helper walk of a WKWebView page.
const HEADER = ['App=webfixture (pid 5310)', 'Window: "Fixture News", App: webfixture.', '']
const FOOTER = ['', 'The focused UI element is 16 text field (settable) Title, Value: draft.']
const BEFORE = [
  '0 standard window Fixture News',
  '\t1 scroll area',
  '\t\t2 HTML content Fixture News',
  '\t\t\t3 container',
  '\t\t\t\t4 link Home',
  '\t\t\t\t6 link New',
  '\t\t\t\t8 link Ask',
  '\t\t\t\t10 text field (settable) Placeholder: Search stories',
  '\t\t\t\t11 button Search',
  '\t\t\t12 heading Top stories',
  '\t\t\t13 container',
  '\t\t\t\t14 container',
  '\t\t\t\t\t15 text Title',
  '\t\t\t\t\t16 text field (settable) Title, Value: draft',
  '\t\t\t\t17 container',
  '\t\t\t\t\t18 text URL',
  '\t\t\t\t\t19 text field (settable) URL',
  '\t\t\t\t20 pop up button, Value: News',
  '\t\t\t\t21 button Submit',
  '\t\t\t22 content list',
  '\t\t\t\t23 container, Value: 0 points',
  '\t\t\t\t\t25 link Story number 0 about computer use',
  '\t\t\t\t\t26 button Upvote 0',
  '\t\t\t\t27 container, Value: 7 points',
  '\t\t\t\t\t29 link Story number 1 about computer use',
  '\t\t\t\t\t30 button Upvote 1',
  '\t985 text Fixture News'
]

function tree(lines: string[], footer = FOOTER): string {
  return [...HEADER, ...lines, ...footer].join('\n')
}

function replaceLine(lines: string[], from: string, to: string[]): string[] {
  const at = lines.indexOf(from)
  return [...lines.slice(0, at), ...to, ...lines.slice(at + 1)]
}

describe('diffComputerTreeText', () => {
  it('sends only changed lines when elements keep their locations', () => {
    const after = replaceLine(BEFORE, '\t\t\t\t\t16 text field (settable) Title, Value: draft', [
      '\t\t\t\t\t16 text field (settable) Title, Value: Computer use diffs'
    ])

    const diff = diffComputerTreeText(tree(BEFORE), tree(after))

    expect(diff).toMatchObject({ changed: 1, added: 0, removed: 0 })
    expect(diff?.text).toBe(
      [
        'App=webfixture (pid 5310)',
        'Window: "Fixture News", App: webfixture.',
        '',
        'Changes since the previous snapshot (~ changed, - removed). Unchanged elements are omitted and keep their indexes.',
        '~ \t\t\t\t\t16 text field (settable) Title, Value: Computer use diffs',
        ...FOOTER
      ].join('\n')
    )
  })

  it('summarizes removed elements as index ranges', () => {
    const after = BEFORE.filter(
      (line) => !/^\t+(23|25|26|27|29) /u.test(line) && !line.includes('Upvote 1')
    )

    const diff = diffComputerTreeText(tree(BEFORE), tree(after))

    expect(diff).toMatchObject({ changed: 0, added: 0, removed: 6 })
    expect(diff?.text).toContain('\n- 23, 25-27, 29-30\n')
  })

  it('says nothing changed and still reports the focused element', () => {
    const diff = diffComputerTreeText(tree(BEFORE), tree(BEFORE))

    expect(diff?.text).toBe(
      [
        ...HEADER,
        'No change in the accessibility tree since the previous snapshot.',
        ...FOOTER
      ].join('\n')
    )
  })

  it.each(['\t\t\t\t14 container', '\t\t\t\t17 container'])(
    'returns the full tree for a checkbox inserted under %s',
    (parent) => {
      const after = replaceLine(BEFORE, parent, [parent, '\t\t\t\t\t986 checkbox Enabled'])

      expect(diffComputerTreeText(tree(BEFORE), tree(after))).toBeNull()
    }
  )

  it('returns the full tree when siblings change order', () => {
    const story0 = BEFORE.slice(20, 23)
    const story1 = BEFORE.slice(23, 26)
    const after = [...BEFORE.slice(0, 20), ...story1, ...story0, ...BEFORE.slice(26)]

    const diff = diffComputerTreeText(tree(BEFORE), tree(after))

    expect(diff).toBeNull()
  })

  const titleField = '\t\t\t\t\t16 text field (settable) Title, Value: draft'
  const reparented = replaceLine(BEFORE, '\t\t\t\t\t15 text Title', [
    '\t\t\t\t986 container New fields',
    '\t\t\t\t\t15 text Title'
  ])

  it.each([
    { change: 'inserted parent', before: BEFORE, after: reparented },
    { change: 'removed parent', before: reparented, after: BEFORE },
    {
      change: 'existing parent',
      before: BEFORE,
      after: replaceLine(replaceLine(BEFORE, titleField, []), '\t\t\t\t17 container', [
        '\t\t\t\t17 container',
        titleField
      ])
    }
  ])('returns the full tree after reparenting through $change', ({ before, after }) => {
    expect(diffComputerTreeText(tree(before), tree(after))).toBeNull()
  })

  it('falls back to the full tree when an insert renumbered everything after it', () => {
    const renumbered = BEFORE.map((line, position) =>
      position < 9
        ? line
        : line.replace(/^(\t*)(\d+)/u, (_, tabs, index) => `${tabs}${Number(index) + 1}`)
    )

    expect(diffComputerTreeText(tree(BEFORE), tree(renumbered))).toBeNull()
  })

  it('keeps names that carried raw newlines on their own element', () => {
    // Older helpers printed multi-line custom action names verbatim.
    const before = [
      ...BEFORE.slice(0, -1),
      '\t990 toolbar',
      '\t\t991 button (disabled) Stop, Secondary Actions: name: move next',
      ' target:0x0',
      ' selector:(null)',
      '\t\t992 button Inspector',
      ...BEFORE.slice(-1)
    ]
    const after = replaceLine(before, '\t\t992 button Inspector', [
      '\t\t992 button (disabled) Inspector'
    ])

    const diff = diffComputerTreeText(tree(before), tree(after))

    expect(diff?.text).toContain('~ \t\t992 button (disabled) Inspector')
    expect(diff?.text).not.toContain('target:0x0')
  })
})

describe('ComputerTreeBaselines', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function result(treeText: string, windowId = 42, pid = 5310): ComputerSnapshotResult {
    return {
      snapshot: {
        id: `snap-${treeText.length}-${windowId}`,
        app: { name: 'webfixture', bundleId: null, pid },
        window: { id: windowId, title: 'Fixture News', width: 1200, height: 900 },
        coordinateSpace: 'window',
        treeText,
        elementCount: 27,
        focusedElementId: 16
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
    }
  }

  const edited = tree(
    replaceLine(BEFORE, '\t\t\t\t\t16 text field (settable) Title, Value: draft', [
      '\t\t\t\t\t16 text field (settable) Title, Value: hello'
    ])
  )

  it('diffs an action result against the tree this caller saw last for the window', () => {
    const baselines = new ComputerTreeBaselines()
    const first = baselines.apply({ app: 'webfixture', session: 'a' }, result(tree(BEFORE)))

    const second = baselines.apply(
      { app: 'webfixture', session: 'a', treeDiff: true },
      result(edited)
    )

    expect(second.snapshot.treeDiff).toEqual({
      baseSnapshotId: first.snapshot.id,
      changed: 1,
      added: 0,
      removed: 0
    })
    expect(second.snapshot.treeText).toContain(
      '~ \t\t\t\t\t16 text field (settable) Title, Value: hello'
    )
    expect(second.snapshot.elementCount).toBe(27)
  })

  it('returns the full tree to callers that did not ask for a diff', () => {
    const baselines = new ComputerTreeBaselines()
    baselines.apply({ app: 'webfixture' }, result(tree(BEFORE)))

    const second = baselines.apply({ app: 'webfixture' }, result(edited))

    expect(second.snapshot.treeText).toBe(edited)
    expect(second.snapshot.treeDiff).toBeUndefined()
  })

  it('returns the full tree when the action landed in another window', () => {
    const baselines = new ComputerTreeBaselines()
    baselines.apply({ app: 'webfixture' }, result(tree(BEFORE), 42))

    const second = baselines.apply({ app: 'webfixture', treeDiff: true }, result(edited, 43))

    expect(second.snapshot.treeText).toBe(edited)
  })

  it('keeps each session to its own last view', () => {
    const baselines = new ComputerTreeBaselines()
    baselines.apply({ app: 'webfixture', session: 'a' }, result(tree(BEFORE)))
    baselines.apply({ app: 'webfixture', session: 'b' }, result(edited))

    const fromA = baselines.apply(
      { app: 'webfixture', session: 'a', treeDiff: true },
      result(edited)
    )

    expect(fromA.snapshot.treeDiff?.changed).toBe(1)
  })

  it('stops diffing against a view older than the provider snapshot cache', () => {
    vi.useFakeTimers()
    const baselines = new ComputerTreeBaselines()
    baselines.apply({ app: 'webfixture' }, result(tree(BEFORE)))
    vi.advanceTimersByTime(2 * 60 * 1000 + 1)

    const second = baselines.apply({ app: 'webfixture', treeDiff: true }, result(edited))

    expect(second.snapshot.treeText).toBe(edited)
  })
})
