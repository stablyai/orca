// Perf contract for #45032: a completion-only status restatement must not list workspace terminals for plugins.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusClearIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { PluginAgentStatusChangedPayload } from '../../../shared/plugins/events/plugin-events'
import type { PluginRuntimeDelegate } from '../workers/host-api/plugin-host-service-bindings'
import { createPluginAgentStatusForwarder } from './plugin-runtime-binding'

function harness() {
  const listTerminals = vi.fn(async () => ({ terminals: [] }))
  const emitEvent = vi.fn()
  const drops = new Set<(paneKey: string) => void>()
  const clears = new Set<(clear: AgentStatusClearIpcPayload) => void>()
  const forward = createPluginAgentStatusForwarder(
    { listTerminals } as unknown as PluginRuntimeDelegate,
    { emitEvent, wantsEvent: () => true },
    {
      subscribeStatusDrop: (listener) => (drops.add(listener), () => drops.delete(listener)),
      subscribePaneStatusClear: (listener) => (clears.add(listener), () => clears.delete(listener))
    }
  )
  return { forward, listTerminals, emitEvent, drops, clears }
}

function status(
  pane: number,
  receivedAt: number,
  state: 'done' | 'working'
): PluginAgentStatusChangedPayload {
  return {
    workspaceId: `wt-${pane}`,
    paneKey: `tab-${pane}:leaf`,
    state,
    receivedAt,
    mainAgent: { state, stateStartedAt: 2_000 }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('plugin agent status forwarder work', () => {
  it.each([100, 1_000])('skips restatements across %i panes', async (panes) => {
    const { forward, listTerminals, emitEvent } = harness()
    for (let pane = 0; pane < panes; pane++) {
      forward(status(pane, 3_000, 'done'))
    }
    await settle()
    listTerminals.mockClear()
    emitEvent.mockClear()

    forward(status(7, 4_000, 'done'), undefined)
    await settle()
    expect(listTerminals).toHaveBeenCalledTimes(0)
    expect(emitEvent).toHaveBeenCalledTimes(0)

    forward(status(7, 5_000, 'working'))
    await settle()
    expect(listTerminals).toHaveBeenCalledTimes(1)
    expect(emitEvent).toHaveBeenCalledTimes(1)
  })

  it('forwards a pane again once its row is dropped or cleared', async () => {
    const { forward, listTerminals, drops, clears } = harness()
    forward(status(1, 3_000, 'done'))
    forward(status(2, 3_000, 'done'))
    await settle()
    listTerminals.mockClear()

    for (const drop of drops) {
      drop('tab-1:leaf')
    }
    for (const clear of clears) {
      clear({ paneKey: 'tab-2:leaf' })
    }
    forward(status(1, 4_000, 'done'))
    forward(status(2, 4_000, 'done'))
    await settle()
    expect(listTerminals).toHaveBeenCalledTimes(2)
  })
})
