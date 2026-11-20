import { describe, expect, it, vi } from 'vitest'
import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'

function postedPayloads(harness: AgentStatusExtensionHarness): Record<string, unknown>[] {
  return harness.fetchMock.mock.calls.map((call) => {
    const body: { payload: Record<string, unknown> } = JSON.parse(String(call[1]?.body))
    return body.payload
  })
}

function piEditor(initial = '') {
  let text = initial
  let onInput: ((data: string) => { consume?: boolean } | undefined) | null = null
  const stop = vi.fn()
  return {
    ui: {
      getEditorText: () => text,
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
        onInput = handler
        return stop
      }
    },
    stop,
    // Pi calls input listeners before the editor applies the key.
    type(next: string) {
      onInput?.('x')
      text = next
    }
  }
}

describe('Pi composer draft reporting', () => {
  it('reports when the input box gains or loses unsent text, on edges only', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    const editor = piEditor()
    await harness.callHook('session_start', { reason: 'startup' }, { ui: editor.ui })
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
    expect(postedPayloads(harness)[0]).toMatchObject({
      hook_event_name: 'session_start',
      composer_draft: false
    })

    editor.type('h')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    expect(postedPayloads(harness)[1]).toMatchObject({
      hook_event_name: 'composer_draft',
      composer_draft: true
    })

    // More typing keeps a draft: nothing new to report.
    editor.type('hello')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(harness.fetchMock).toHaveBeenCalledTimes(2)

    // Enter submits and clears the box.
    editor.type('')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(3))
    expect(postedPayloads(harness)[2]).toMatchObject({
      hook_event_name: 'composer_draft',
      composer_draft: false
    })
  })

  it('carries the current reading on lifecycle posts', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    const editor = piEditor('half typed')
    await harness.callHook('session_start', { reason: 'startup' }, { ui: editor.ui })
    await harness.callHook('agent_start', {}, { ui: editor.ui })
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    expect(postedPayloads(harness)[1]).toMatchObject({
      hook_event_name: 'agent_start',
      composer_draft: true
    })
  })

  it('reports nothing in native chat, which has no terminal input box', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'pi',
      env: { ORCA_STRUCTURED_SESSION: '1' }
    })
    const editor = piEditor('text')
    await harness.callHook('session_start', { reason: 'startup' }, { ui: editor.ui })
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
    expect(postedPayloads(harness)[0]).not.toHaveProperty('composer_draft')
  })
})
