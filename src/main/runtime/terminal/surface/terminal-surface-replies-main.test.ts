import 'node:path'
import { registerBoundPty } from '../layout/bind-first-pane.test-fixture'
import { describe, expect, it, vi } from 'vitest'

import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import {
  SURFACE_PTYS,
  SURFACE_TAB_ID,
  surfaceRuntime
} from './terminal-surface-replies.test-fixture'

vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: true
}))

const MOUNTED = Object.keys(SURFACE_PTYS).map((leafId, index) => ({
  tabId: SURFACE_TAB_ID,
  leafId,
  paneRuntimeId: index + 1,
  paneTitle: null
}))

describe('terminal replies from main (switch on)', () => {
  it('keep answering after the window closes', async () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })

    runtime.markGraphUnavailable(1)

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(
      listed.terminals.map(({ tabId, leafId, orphaned, title }) => ({
        tabId,
        leafId,
        orphaned,
        title
      }))
    ).toEqual(
      [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID].map((leafId) => ({
        tabId: SURFACE_TAB_ID,
        leafId,
        orphaned: false,
        title: 'Persisted Terminal'
      }))
    )
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveLeafCount: 2 })
    const shown = await runtime.showTerminal(listed.terminals[0]!.handle)
    expect(shown).toMatchObject({ tabId: SURFACE_TAB_ID, ptyId: 'pty-a', paneRuntimeId: -1 })
  })

  it('close one pane of a split by its handle in main, leaving its sibling', async () => {
    const { runtime, store, killed } = surfaceRuntime()
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })
    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const second = listed.terminals.find((terminal) => terminal.ptyId === 'pty-b')!

    await runtime.closeTerminal(second.handle)

    const layout = store.getSession().terminalLayoutsByTabId[SURFACE_TAB_ID]
    expect(layout?.root).toEqual({ type: 'leaf', leafId: HEADLESS_LEAF_ID })
    expect(killed).toEqual(['pty-b'])
  })
})

it('resolves refusal facts only for the exact live launch incarnation', () => {
  const { runtime } = surfaceRuntime()
  const pane = { tabId: SURFACE_TAB_ID, leafId: HEADLESS_LEAF_ID }
  registerBoundPty(runtime, 'pty-a', TEST_WORKTREE_ID, null, {
    ...pane,
    incarnationId: 'inc-refused',
    launchToken: 'attempt-refused'
  })
  runtime.rememberSavedTerminalLaunchResult('pty-a', {
    agentResumeRefused: 'chat-home',
    agentResumeUnavailable: true,
    savedResumeDecision: {
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'conversation-1' },
      verdict: 'chat-home'
    }
  })
  const resolved = runtime.resolveTerminalPane(
    `${SURFACE_TAB_ID}:${HEADLESS_LEAF_ID}`,
    TEST_WORKTREE_ID
  )
  expect(resolved.agentResumeRefused).toBe('chat-home')
  expect(resolved.agentResumeUnavailable).toBe(true)
  registerBoundPty(runtime, 'pty-a', TEST_WORKTREE_ID, null, {
    ...pane,
    incarnationId: 'inc-successor',
    launchToken: 'attempt-refused'
  })
  expect(
    runtime.resolveTerminalPane(`${SURFACE_TAB_ID}:${HEADLESS_LEAF_ID}`, TEST_WORKTREE_ID)
      .agentResumeRefused
  ).toBeUndefined()
})
