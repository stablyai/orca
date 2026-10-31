import '../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import type { StoppedSwitchSourceFact } from '../../../shared/stopped-switch-source'
import { StoppedSwitchSourceFacts } from './stopped-switch-source-facts'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from '../rpc/terminal-multiplex-test-harness'

const pane = { worktreeId: 'w', tabId: 'tab', leafId: 'leaf' }
const fact = (agent: 'claude' | 'codex'): StoppedSwitchSourceFact => ({
  ptyId: 'pty-stopped',
  incarnationId: 'inc-1',
  agent,
  providerSessionId: `${agent}-conversation`
})
const row = (extra: Partial<RuntimeMobileSessionTerminalTab> = {}) =>
  ({
    type: 'terminal',
    id: 'tab::leaf',
    title: 'Terminal',
    parentTabId: 'tab',
    leafId: 'leaf',
    isActive: true,
    ...extra
  }) satisfies RuntimeMobileSessionTerminalTab
const frame = (...tabs: RuntimeMobileSessionTerminalTab[]): RuntimeMobileSessionTabsSnapshot => ({
  worktree: 'w',
  publicationEpoch: 'epoch',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs
})
/** What the projection publishes for the pane after this frame. */
const published = (
  facts: StoppedSwitchSourceFacts,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  current: Parameters<StoppedSwitchSourceFacts['reconcile']>[1]
) => {
  facts.reconcile(snapshot, current)
  return facts.factFor(pane.worktreeId, pane.tabId, pane.leafId)
}
const exited = () => ({ connected: false, incarnationId: 'inc-1' })

it.each(['claude', 'codex'] as const)(
  'carries the fact on its pane in every frame while the pane names that process (%s)',
  (agent) => {
    const facts = new StoppedSwitchSourceFacts()
    facts.record(pane, fact(agent))
    // Before the window unbinds the pane, and after (a reconnect or new viewer re-reads it).
    expect(published(facts, frame(row({ ptyId: 'pty-stopped' })), exited)).toEqual(fact(agent))
    expect(published(facts, frame(row()), exited)).toEqual(fact(agent))
    expect(facts.stoppedProcess('pty-stopped', 'inc-1')).toBe(true)
  }
)

it.each([
  ['Restart or a rebind names another process', frame(row({ ptyId: 'pty-new' })), exited],
  ['the pane closed, or a retry replaced it', frame(), exited],
  [
    'a successor runs on the same PTY id',
    frame(row()),
    () => ({ connected: true, incarnationId: 'inc-2' })
  ]
] as const)('drops the fact for good when %s', (_case, next, current) => {
  const facts = new StoppedSwitchSourceFacts()
  facts.record(pane, fact('codex'))
  facts.reconcile(next, current)
  expect(published(facts, frame(row()), exited)).toBeUndefined()
  expect(facts.stoppedProcess('pty-stopped', 'inc-1')).toBe(false)
})

it.each([50, 500])(
  'does no row pass over a %i-terminal frame without a stopped source, and one pass with one',
  (n) => {
    const rows = Array.from({ length: n }, (_, index) => row({ leafId: `leaf-${index}` }))
    let passes = 0
    const counted: RuntimeMobileSessionTabsSnapshot = {
      ...frame(),
      get tabs() {
        passes += 1
        return rows
      }
    }
    const facts = new StoppedSwitchSourceFacts()
    facts.record({ ...pane, worktreeId: 'other' }, fact('codex'))
    const current = vi.fn(exited)
    facts.reconcile(counted, current)
    expect(passes).toBe(0)
    facts.record({ ...pane, leafId: 'leaf-0' }, fact('codex'))
    facts.reconcile(counted, current)
    expect(passes).toBe(1)
    expect(current).toHaveBeenCalledOnce()
  }
)

it('never names an unknown or other incarnation stopped', () => {
  const facts = new StoppedSwitchSourceFacts()
  facts.record(pane, fact('codex'))
  expect(facts.stoppedProcess('pty-stopped', undefined)).toBe(false)
  expect(facts.stoppedProcess('pty-stopped', 'inc-2')).toBe(false)
})

it('answers an attach to a stopped source with the definitive exit', async () => {
  const resolveLiveLeafForHandle = vi.fn()
  const harness = startDesktopMultiplexSubscribe({
    isStoppedSwitchSourceHandle: (handle) => handle === 'terminal-1',
    resolveLiveLeafForHandle
  })
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  sendDesktopMultiplexSubscribe(harness.handlers)
  await vi.waitFor(() =>
    expect(harness.messages.map((message) => JSON.parse(message).result)).toContainEqual(
      expect.objectContaining({ type: 'end', streamId: 7 })
    )
  )
  expect(harness.messages.join('\n')).toContain('terminal_exited')
  expect(resolveLiveLeafForHandle).not.toHaveBeenCalled()
})
