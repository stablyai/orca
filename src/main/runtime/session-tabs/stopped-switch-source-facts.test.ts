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
import { RpcDispatcher } from '../rpc/dispatcher'
import { TERMINAL_METHODS } from '../rpc/methods/terminal'
import type { OrcaRuntimeService } from '../orca-runtime'

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
const stoppedOn = (snapshot: RuntimeMobileSessionTabsSnapshot) => {
  const tab = snapshot.tabs[0]
  return tab?.type === 'terminal' ? tab.stoppedSwitchSource : undefined
}
const exited = () => ({ connected: false, incarnationId: 'inc-1' })

it.each(['claude', 'codex'] as const)(
  'carries the fact on its pane in every frame while the pane names that process (%s)',
  (agent) => {
    const facts = new StoppedSwitchSourceFacts()
    facts.record(pane, fact(agent))
    // Before the window unbinds the pane, and after (a reconnect or new viewer re-reads it).
    expect(stoppedOn(facts.stamp(frame(row({ ptyId: 'pty-stopped' })), exited))).toEqual(
      fact(agent)
    )
    expect(stoppedOn(facts.stamp(frame(row()), exited))).toEqual(fact(agent))
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
  facts.stamp(next, current)
  expect(stoppedOn(facts.stamp(frame(row()), exited))).toBeUndefined()
  expect(facts.stoppedProcess('pty-stopped', 'inc-1')).toBe(false)
})

it('neither keeps a field a renderer republished nor costs a copy when there is none', () => {
  const facts = new StoppedSwitchSourceFacts()
  expect(stoppedOn(facts.stamp(frame(row({ stoppedSwitchSource: fact('codex') })), exited))).toBe(
    undefined
  )
  const plain = frame(row({ ptyId: 'pty-live' }))
  expect(facts.stamp(plain, exited)).toBe(plain)
})

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

it('answers a phone or legacy subscribe to a stopped source with the definitive exit, mounting nothing', async () => {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    isStoppedSwitchSourceHandle: (handle: string) => handle === 'terminal-1',
    resolveLeafForHandle: vi.fn(),
    requestRendererTerminalTabMount: vi.fn(() => true),
    waitForLeafPtyId: vi.fn()
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal reads only these runtime members.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: TERMINAL_METHODS
  })
  const sent: string[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'req-1',
      authToken: 'tok',
      method: 'terminal.subscribe',
      params: {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      }
    },
    (message) => sent.push(message),
    {
      connectionId: 'conn-phone',
      sendBinary: vi.fn(),
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    }
  )
  expect(sent.join('\n')).toContain('terminal_exited')
  expect(runtime.resolveLeafForHandle).not.toHaveBeenCalled()
  expect(runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
  expect(runtime.waitForLeafPtyId).not.toHaveBeenCalled()
})
