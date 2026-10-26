import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_LEAF_ID, TEST_WORKTREE_ID } from '../../orca-runtime-test-fixtures.spec'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { PaneStartStatuses } from '../../pane-start-statuses'
import { SURFACE_TAB_ID, surfaceRuntime } from './terminal-surface-replies.test-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const PANE_KEY = makePaneKey(SURFACE_TAB_ID, HEADLESS_LEAF_ID)

/** The scenario with its first pane holding an agent resume record (a sleep record by default). */
function sleepingPaneRuntime(
  hostLists?: () => readonly string[],
  origin?: SleepingAgentSessionRecord['origin']
): ReturnType<typeof surfaceRuntime> {
  const harness = surfaceRuntime({ hostLists })
  const session = harness.store.getSession()
  harness.setSession({
    ...session,
    sleepingAgentSessionsByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: SURFACE_TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'session-1' },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        ...(origin ? { origin } : {})
      }
    }
  })
  harness.runtime.attachWindow(1)
  harness.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: [] })
  return harness
}

async function firstPaneRow(
  runtime: ReturnType<typeof surfaceRuntime>['runtime']
): Promise<{ connected: boolean; writable: boolean; verdict: unknown } | undefined> {
  const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
  const row = listed.terminals.find((terminal) => terminal.leafId === HEADLESS_LEAF_ID)
  return row && { connected: row.connected, writable: row.writable, verdict: row.verdict }
}

// Layout-owner build: a terminal.list row carries the host's verdict; a pane with a status is never live.
describe("main's pane verdicts (switch on)", () => {
  // Every status main publishes on a bound pane (PaneStartStatus), and the sleeping record.
  it.each(['starting', 'failed', 'sleeping', 'resuming', 'held', 'sleeping record'] as const)(
    'a %s pane whose terminal still runs is not connected and never live',
    async (status) => {
      const harness = status === 'sleeping record' ? sleepingPaneRuntime() : surfaceRuntime()
      if (status !== 'sleeping record') {
        harness.runtime.attachWindow(1)
        harness.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: [] })
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the layout-owner runtime always holds this register; the test sets a start status as main's start does.
        const { paneStartStatuses } = harness.runtime as unknown as {
          paneStartStatuses: PaneStartStatuses
        }
        paneStartStatuses.set(PANE_KEY, { status })
      }

      expect(await firstPaneRow(harness.runtime)).toEqual({
        connected: false,
        writable: false,
        verdict: 'unverifiable'
      })
    }
  )

  // A running agent's resume record ('live', or 'quit' on a warm reattach) is not a sleep.
  it.each(['live', 'quit'] as const)(
    "a pane bound to a running terminal with a '%s' resume record is connected and live",
    async (origin) => {
      const { runtime } = sleepingPaneRuntime(undefined, origin)

      expect(await firstPaneRow(runtime)).toEqual({
        connected: true,
        writable: true,
        verdict: 'live'
      })
    }
  )

  it("a pane with a 'worktree-sleep' record still reads as sleeping", async () => {
    const { runtime } = sleepingPaneRuntime(undefined, 'worktree-sleep')

    expect(await firstPaneRow(runtime)).toEqual({
      connected: false,
      writable: false,
      verdict: 'unverifiable'
    })
  })

  it('a sleeping pane whose terminal the host reports absent is exited', async () => {
    let hostLists = ['pty-a', 'pty-b']
    const { runtime } = sleepingPaneRuntime(() => hostLists)
    hostLists = ['pty-b']

    expect(await firstPaneRow(runtime)).toMatchObject({ connected: false, verdict: 'exited' })
  })
})
