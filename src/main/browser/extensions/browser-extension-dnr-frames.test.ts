import { describe, expect, it } from 'vitest'
import { DnrEngine, createDnrRequestState } from './declarative-net-request/engine'
import { buildDnrRuleset } from './declarative-net-request/ruleset-builder'
import { DnrFrameTracker } from './browser-extension-dnr-frames'

const EXT = 'f'.repeat(32)
const TAB = 4

function engineWith(rules: unknown[]): DnrEngine {
  const engine = new DnrEngine()
  engine.setExtension(EXT, { installTime: 1 })
  const source = { kind: 'static' as const, id: 'main', manifestIndex: 0 }
  const built = buildDnrRuleset(rules, { extensionId: EXT, source, invalidRules: 'error' })
  if (!built.ok) {
    throw new Error(built.error.message)
  }
  engine.setRuleset(EXT, source, built.index)
  return engine
}

type FakeFrame = { frameTreeNodeId: number; origin: string; parent: FakeFrame | null }

function frame(node: number, origin: string, parent: FakeFrame | null = null): FakeFrame {
  return { frameTreeNodeId: node, origin, parent }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracker reads only frameTreeNodeId, origin and parent.
const asFrame = (fake: FakeFrame) => fake as unknown as Electron.WebFrameMain

/** Whether a script request from `node` is blocked under that frame's committed state. */
function blocked(engine: DnrEngine, tracker: DnrFrameTracker, node: number): boolean {
  const result = engine.evaluateBeforeRequest(
    {
      url: 'https://ads.example/a.js',
      method: 'GET',
      type: 'script',
      initiator: 'https://news.example',
      tabId: TAB
    },
    createDnrRequestState(),
    { frameAllow: tracker.allowFor(node) }
  )
  return result.actions.at(0)?.type === 'block'
}

describe('declarativeNetRequest frame state', () => {
  const engine = engineWith([
    { id: 1, condition: { urlFilter: '||ads.example^' }, action: { type: 'block' } },
    {
      id: 2,
      priority: 2,
      condition: { requestDomains: ['news.example'], resourceTypes: ['main_frame'] },
      action: { type: 'allowAllRequests' }
    }
  ])

  it('lets an allowAllRequests page and its frames load everything', () => {
    const tracker = new DnrFrameTracker(() => TAB)
    const main = frame(1, 'https://news.example')
    tracker.commit(engine, TAB, asFrame(main), 'https://news.example/')
    const child = frame(2, 'https://widgets.example', main)
    tracker.commit(engine, TAB, asFrame(child), 'https://widgets.example/embed')
    const blank = frame(3, 'https://news.example', main)
    tracker.commit(engine, TAB, asFrame(blank), 'about:blank')
    expect(tracker.hasAllowStates()).toBe(true)
    expect([1, 2, 3].map((node) => blocked(engine, tracker, node))).toEqual([false, false, false])
    expect(tracker.topOrigin(TAB)).toBe('https://news.example')
  })

  it("forgets the old document's frames when the main frame commits elsewhere", () => {
    const tracker = new DnrFrameTracker(() => TAB)
    const main = frame(1, 'https://news.example')
    tracker.commit(engine, TAB, asFrame(main), 'https://news.example/')
    tracker.commit(engine, TAB, asFrame(frame(2, 'https://w.example', main)), 'https://w.example/')
    tracker.commit(engine, TAB, asFrame(frame(1, 'https://shop.example')), 'https://shop.example/')
    expect(tracker.hasAllowStates()).toBe(false)
    expect([1, 2].map((node) => blocked(engine, tracker, node))).toEqual([true, true])
    expect(tracker.topOrigin(TAB)).toBe('https://shop.example')
  })

  it('tracks top origins without an engine and resolves tab ids once per document', () => {
    let resolved = 0
    let registered = false
    const tracker = new DnrFrameTracker(() => {
      resolved++
      return registered ? 11 : -1
    })
    // A restored tab's first requests come before Orca's window lists it.
    expect(tracker.tabIdFor(11)).toBe(-1)
    registered = true
    resolved = 0
    expect([tracker.tabIdFor(11), tracker.tabIdFor(11), tracker.tabIdFor(undefined)]).toEqual([
      11, 11, -1
    ])
    expect(resolved).toBe(1)
    tracker.commit(null, 11, asFrame(frame(1, 'https://a.example')), 'https://a.example/')
    expect(tracker.topOrigin(11)).toBe('https://a.example')
    tracker.tabIdFor(11)
    expect(resolved).toBe(2)
    tracker.forgetContents(11)
    expect(tracker.topOrigin(11)).toBeNull()
  })
})
