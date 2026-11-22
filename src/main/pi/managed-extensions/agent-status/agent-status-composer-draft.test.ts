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
    },
    // An extension's setEditorText changes the box without a key.
    set(next: string) {
      text = next
    }
  }
}

function lastDraftReport(harness: AgentStatusExtensionHarness): unknown {
  return postedPayloads(harness).findLast((payload) => 'composer_draft' in payload)?.composer_draft
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

  it('resends a draft report that Orca did not receive', async () => {
    let calls = 0
    const harness = createAgentStatusExtensionHarness({
      kind: 'pi',
      fetchImpl: async () => {
        calls += 1
        if (calls === 2) {
          throw new Error('hook server restarting')
        }
        return { ok: true }
      }
    })
    const editor = piEditor()
    await harness.callHook('session_start', { reason: 'startup' }, { ui: editor.ui })
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))

    editor.type('h')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(3), { timeout: 2000 })
    expect(postedPayloads(harness)[2]).toMatchObject({
      hook_event_name: 'composer_draft',
      composer_draft: true
    })
  })

  it('reports a draft typed again while the empty-box report is in flight', async () => {
    const emptyReport: { release?: () => void } = {}
    const harness = createAgentStatusExtensionHarness({
      kind: 'pi',
      fetchImpl: async (_url, init) => {
        const body = String(init?.body)
        const isEmptyReport =
          body.includes('"hook_event_name":"composer_draft"') &&
          body.includes('"composer_draft":false')
        if (isEmptyReport && !emptyReport.release) {
          await new Promise<void>((resolve) => {
            emptyReport.release = resolve
          })
        }
        return { ok: true }
      }
    })
    const editor = piEditor()
    await harness.callHook('session_start', { reason: 'startup' }, { ui: editor.ui })
    editor.type('h')
    await vi.waitFor(() => expect(lastDraftReport(harness)).toBe(true))

    editor.type('')
    await vi.waitFor(() => expect(emptyReport.release).toBeDefined())
    // Typed while Orca has not yet received the empty box.
    editor.type('again')
    await new Promise((resolve) => setTimeout(resolve, 10))
    emptyReport.release?.()
    await vi.waitFor(() => expect(lastDraftReport(harness)).toBe(true))
  })

  it('reports a draft cleared during /reload', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    const editor = piEditor()
    await harness.callHook('session_start', { reason: 'startup' }, { ui: editor.ui })
    editor.type('h')
    await vi.waitFor(() => expect(lastDraftReport(harness)).toBe(true))

    await harness.reloadPi()
    editor.set('')
    await harness.callHook('session_start', { reason: 'reload' }, { ui: editor.ui })
    await vi.waitFor(() => expect(lastDraftReport(harness)).toBe(false))
  })

  it('carries text an extension set without a key on the next post', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    const editor = piEditor()
    await harness.callHook('session_start', { reason: 'startup' }, { ui: editor.ui })
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))

    editor.set('prefilled')
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
