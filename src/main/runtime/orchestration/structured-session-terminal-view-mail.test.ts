import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import { OrchestrationMailboxOwner, type OrchestrationMailboxLeaf } from './mailbox-owner'

const CHAT = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const CHAT_ACTOR = `session:${CHAT}`
const VIEW_TAB = 'tab_view'
const VIEW_LEAF = '77777777-7777-4777-8777-777777777777'

let db: OrchestrationDb

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  db.close()
})

const viewLeaf: OrchestrationMailboxLeaf = {
  tabId: VIEW_TAB,
  leafId: VIEW_LEAF,
  ptyId: 'pty-view',
  writable: true,
  lastAgentStatus: 'idle',
  lastAgentStatusObservedLive: true,
  lastOscTitle: null
}

function owner(boundSessionId: string | null): OrchestrationMailboxOwner {
  return new OrchestrationMailboxOwner({
    getDb: () => db,
    getLeaf: () => viewLeaf,
    getLeafKey: (tabId, leafId) => `${tabId}::${leafId}`,
    getTerminalHandleForLeafKey: () => 'term_view',
    getTerminalProcessIncarnation: () => null,
    onRoutedMessageTypes: vi.fn(),
    onForeignMailboxRouted: vi.fn(),
    getBoundSessionIdForPty: (ptyId) => (ptyId === 'pty-view' ? boundSessionId : null)
  })
}

function chatRun(): string {
  return db.createRun({
    objective: 'o',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorActor: CHAT_ACTOR
  }).id
}

describe("a chat's terminal view reads the chat's mail", () => {
  it('owns the Run the chat coordinates, which no pane binding names', () => {
    // The CLI in a terminal view acts as the session, so the Run is bound by actor and the pane
    // path finds nothing: without this the idle edge of the view never pointed coordinator mail.
    const runId = chatRun()
    expect(owner(CHAT).resolve(viewLeaf)).toBe(`run:${runId}`)
    expect(owner(CHAT).resolve(viewLeaf, `run:${runId}`)).toBe(`run:${runId}`)
    expect(owner(null).resolve(viewLeaf)).toBe('term_view')
  })

  it('falls back to the pane for a terminal whose session owns nothing', () => {
    const runId = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_view',
      coordinatorPaneKey: `${VIEW_TAB}:${VIEW_LEAF}`
    }).id
    expect(owner(CHAT).resolve(viewLeaf)).toBe(`run:${runId}`)
  })

  it("resolves a chat-coordinated Run's mailbox to the terminal view's handle", () => {
    const runId = chatRun()
    const target = new OrchestrationMailboxDeliveryTarget({
      getDb: () => db,
      getTerminalHandleForPaneKey: () => null,
      hasTerminalHandle: (handle) => handle === 'term_view',
      isStructuredWorkerHandle: () => false,
      canProbePtyLiveness: () => false,
      controllerKnowsPtyIsLive: () => true,
      isLeafPtyProvenAbsent: async () => false,
      getTerminalViewHandleForSession: (sessionId) => (sessionId === CHAT ? 'term_view' : null)
    })
    expect(target.resolveTerminalHandle(`run:${runId}`)).toBe('term_view')
  })
})
