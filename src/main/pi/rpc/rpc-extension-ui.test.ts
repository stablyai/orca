import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeExtensionUiRigs,
  openExtensionUiRig,
  GENERATION,
  NAMESPACE,
  SESSION
} from './pi-extension-ui-journal-rig.test-fixture'
import { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import type { JsonlRpcRecord } from '../../jsonl-rpc/peer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  AGENT_SESSION_EXTENSION_NOTICE_PRESENTATION,
  agentSessionExtensionStripRows
} from '../../../shared/agent-session/view/agent-session-extension-ui'
import { PiRpcDialogCallbacks } from './rpc-dialog-callbacks'

const lanes: JsonlRpcTimelineLane[] = []
afterEach(async () => {
  for (const lane of lanes.splice(0)) {
    lane.dispose()
  }
  await closeExtensionUiRigs()
})

type ExtensionFrame = { method: string } & Record<string, unknown>

// The real lane, sink and journal: a frame either reaches the chat's rows or it does not.
async function rig() {
  const journal = await openExtensionUiRig()
  const lane = new JsonlRpcTimelineLane({
    sink: journal.sink,
    sessionId: SESSION,
    agent: 'pi',
    generation: GENERATION,
    namespace: NAMESPACE,
    pauseReading: () => {},
    resumeReading: () => {},
    onInputAccepted: () => {},
    onFailed: (reason) => {
      throw new Error(reason)
    }
  })
  lanes.push(lane)
  const send = vi.fn<(frame: JsonlRpcRecord) => Promise<void>>(async () => {})
  const dialogs = new PiRpcDialogCallbacks(
    lane,
    send,
    (error) => {
      throw error
    },
    null,
    () => {},
    GENERATION
  )
  return {
    journal,
    send,
    dialogs,
    receive: (frame: ExtensionFrame) => dialogs.receive({ ...frame, type: 'extension_ui_request' }),
    rows: async (): Promise<AgentJournalRenderItem[]> =>
      (await journal.rows()).filter((item) => item.body.kind === 'status')
  }
}

describe('Pi RPC extension UI', () => {
  it('draws notify as a chat notice in the extension’s own tone', async () => {
    const test = await rig()
    test.receive({ method: 'notify', message: 'Command blocked by user', notifyType: 'warning' })
    test.receive({ method: 'notify', message: 'Todo list updated' })

    const rows = await test.rows()
    expect(rows.map((item) => item.body)).toEqual([
      expect.objectContaining({
        kind: 'status',
        text: 'Command blocked by user',
        tone: 'warning',
        presentation: AGENT_SESSION_EXTENSION_NOTICE_PRESENTATION
      }),
      expect.objectContaining({ kind: 'status', text: 'Todo list updated' })
    ])
    // A notice is chat history, not a strip: the second one is its own row.
    expect(new Set(rows.map((item) => item.itemId)).size).toBe(2)
    expect(agentSessionExtensionStripRows(rows)).toEqual({ statuses: [], widgets: [] })
  })

  it('keeps one keyed status row, updated in place and gone when pi clears it', async () => {
    const test = await rig()
    test.receive({ method: 'setStatus', statusKey: 'pi-lens', statusText: 'Turn 3 running…' })
    test.receive({ method: 'setStatus', statusKey: 'other-ext', statusText: 'Indexing' })

    const first = agentSessionExtensionStripRows(await test.rows())
    expect(first.statuses.map((row) => row.text)).toEqual(['Turn 3 running…', 'Indexing'])

    test.receive({ method: 'setStatus', statusKey: 'pi-lens', statusText: 'Turn 3 done' })
    const updated = await test.rows()
    expect(agentSessionExtensionStripRows(updated).statuses.map((row) => row.text)).toEqual([
      'Turn 3 done',
      'Indexing'
    ])
    // Same journal row: the strip revises rather than piling up entries.
    expect(new Set(updated.map((item) => item.itemId)).size).toBe(2)

    test.receive({ method: 'setStatus', statusKey: 'pi-lens' })
    expect(
      agentSessionExtensionStripRows(await test.rows()).statuses.map((row) => row.text)
    ).toEqual(['Indexing'])
  })

  it('pins a widget’s lines above or below the composer and keeps the key’s identity', async () => {
    const test = await rig()
    test.receive({
      method: 'setWidget',
      widgetKey: 'rpiv-todo',
      widgetLines: ['── Todos ──', '[ ] write tests', '[x] read code']
    })
    test.receive({
      method: 'setWidget',
      widgetKey: 'footer',
      widgetLines: ['3 warnings'],
      widgetPlacement: 'belowEditor'
    })

    const widgets = agentSessionExtensionStripRows(await test.rows()).widgets
    expect(widgets.map((widget) => [widget.placement, widget.lines])).toEqual([
      ['above', ['── Todos ──', '[ ] write tests', '[x] read code']],
      ['below', ['3 warnings']]
    ])

    test.receive({
      method: 'setWidget',
      widgetKey: 'rpiv-todo',
      widgetLines: ['── Todos ──', '[x] write tests']
    })
    const updated = agentSessionExtensionStripRows(await test.rows()).widgets
    expect(updated.map((widget) => widget.lines)).toEqual([
      ['── Todos ──', '[x] write tests'],
      ['3 warnings']
    ])
    expect(updated[0]?.itemId).toBe(widgets[0]?.itemId)

    test.receive({ method: 'setWidget', widgetKey: 'rpiv-todo' })
    expect(
      agentSessionExtensionStripRows(await test.rows()).widgets.map((widget) => widget.placement)
    ).toEqual(['below'])

    // The same lines in another placement still move the panel.
    test.receive({
      method: 'setWidget',
      widgetKey: 'footer',
      widgetLines: ['3 warnings'],
      widgetPlacement: 'aboveEditor'
    })
    expect(
      agentSessionExtensionStripRows(await test.rows()).widgets.map((widget) => widget.placement)
    ).toEqual(['above'])
  })

  it('counts a widget’s embedded newlines against the line budget', async () => {
    const test = await rig()
    test.receive({ method: 'setWidget', widgetKey: 'flood', widgetLines: ['x\n'.repeat(250)] })

    const [widget] = agentSessionExtensionStripRows(await test.rows()).widgets
    expect(widget?.lines).toHaveLength(64)
  })

  it('answers no request for the calls it cannot draw', async () => {
    const test = await rig()
    test.receive({ method: 'setTitle', title: 'pi - orca' })
    test.receive({ method: 'set_editor_text', text: 'prefilled text' })

    expect(await test.rows()).toEqual([])
    // Fire-and-forget calls take no response; a cancelled one would be protocol noise.
    expect(test.send).not.toHaveBeenCalled()
  })

  it('leaves none of the child’s keyed rows drawing after it exits', async () => {
    const test = await rig()
    test.receive({ method: 'setStatus', statusKey: 'pi-lens', statusText: 'Indexing' })
    test.receive({ method: 'setWidget', widgetKey: 'rpiv-todo', widgetLines: ['[ ] task'] })

    test.dialogs.close()

    expect(agentSessionExtensionStripRows(await test.rows())).toEqual({
      statuses: [],
      widgets: []
    })
  })
})
