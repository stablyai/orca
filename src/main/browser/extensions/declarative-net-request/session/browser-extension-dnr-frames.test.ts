import { describe, expect, it } from 'vitest'
import { DnrEngine } from '../engine'
import { createDnrRequestState } from '../request-state'
import { buildDnrRuleset } from '../ruleset-builder'
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
})
