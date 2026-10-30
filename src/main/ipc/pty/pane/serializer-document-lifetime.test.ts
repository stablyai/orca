import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  declarePendingPaneSerializer,
  hasPendingRendererSerializerForPaneKey,
  settlePendingPaneSerializer
} from './serializer-state'
import { seedHeadlessTerminalFromSpawnResult } from './terminal-spawn-restore'

let nextSenderId = 1000
const senders: EventEmitter[] = []

function sender() {
  const events = Object.assign(new EventEmitter(), {
    id: nextSenderId++,
    isDestroyed: () => false
  })
  senders.push(events)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: serializer ownership uses only id, isDestroyed and EventEmitter lifecycle methods.
  return { events, contents: events as unknown as WebContents }
}

const paneKey = makePaneKey('tab-document', '33333333-3333-4333-8333-333333333333')

afterEach(() => {
  for (const events of senders.splice(0)) {
    events.emit('destroyed')
  }
})

describe('pending pane serializer document ownership', () => {
  it.each(['render-process-gone', 'did-navigate'] as const)(
    'restores provider history when a pending reattach completes after %s',
    async (event) => {
      const owner = sender()
      const generation = declarePendingPaneSerializer(paneKey, owner.contents)
      expect(hasPendingRendererSerializerForPaneKey(paneKey)).toBe(true)
      owner.events.emit(event)

      const terminal = new Terminal({ cols: 40, rows: 6, scrollback: 100, allowProposedApi: true })
      let writes = Promise.resolve()
      const seedHeadlessTerminal = (_id: string, data: string): void => {
        writes = writes.then(() => new Promise<void>((resolve) => terminal.write(data, resolve)))
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provider-history seeding reads only seedHeadlessTerminal from this runtime seam.
      const runtime = { seedHeadlessTerminal } as unknown as OrcaRuntimeService
      try {
        seedHeadlessTerminalFromSpawnResult(
          runtime,
          { id: 'reattached-pty', isReattach: true, snapshot: 'retained history\r\n' },
          paneKey
        )
        await writes
        await new Promise<void>((resolve) => terminal.write('live suffix\r\n', resolve))
        const lines = Array.from(
          { length: terminal.buffer.active.length },
          (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? ''
        )
        expect(lines).toEqual(['retained history', 'live suffix', '', '', '', ''])
        expect(terminal.buffer.active.cursorX).toBe(0)
        expect(terminal.buffer.active.cursorY).toBe(2)
        expect(settlePendingPaneSerializer(paneKey, generation)).toBe(false)
      } finally {
        terminal.dispose()
      }
    }
  )

  it('preserves an active claim across same-document navigation and ignores old settlement', () => {
    const owner = sender()
    const first = declarePendingPaneSerializer(paneKey, owner.contents)
    owner.events.emit('did-navigate-in-page')
    expect(hasPendingRendererSerializerForPaneKey(paneKey)).toBe(true)
    owner.events.emit('render-process-gone')
    const replacement = declarePendingPaneSerializer(paneKey, owner.contents)
    expect(settlePendingPaneSerializer(paneKey, first)).toBe(false)
    expect(hasPendingRendererSerializerForPaneKey(paneKey)).toBe(true)
    expect(settlePendingPaneSerializer(paneKey, replacement)).toBe(true)
  })

  it('preserves another window owner and registers one listener per document', () => {
    const first = sender()
    const second = sender()
    const firstPane = makePaneKey('first', '44444444-4444-4444-8444-444444444444')
    const secondPane = makePaneKey('second', '55555555-5555-4555-8555-555555555555')
    declarePendingPaneSerializer(firstPane, first.contents)
    declarePendingPaneSerializer(paneKey, first.contents)
    declarePendingPaneSerializer(secondPane, second.contents)
    expect(first.events.listenerCount('render-process-gone')).toBe(1)
    first.events.emit('render-process-gone')
    expect(hasPendingRendererSerializerForPaneKey(firstPane)).toBe(false)
    expect(hasPendingRendererSerializerForPaneKey(paneKey)).toBe(false)
    expect(hasPendingRendererSerializerForPaneKey(secondPane)).toBe(true)
    expect(first.events.eventNames()).toEqual([])
    declarePendingPaneSerializer(firstPane, first.contents)
    expect(first.events.listenerCount('render-process-gone')).toBe(1)
    first.events.emit('did-navigate')
    expect(hasPendingRendererSerializerForPaneKey(firstPane)).toBe(false)
  })
})
