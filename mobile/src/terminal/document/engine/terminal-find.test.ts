// @vitest-environment happy-dom
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from '../document-scope'
import { handleMsg } from '../host-bridge/host-message-router'
import { attachSearchAddon, rerunTerminalFind } from './terminal-find'

const terminals: Terminal[] = []

afterEach(() => {
  terminals.splice(0).forEach((term) => term.dispose())
})

async function searchableDocument(text: string, { attached = true } = {}) {
  const term = new Terminal({ cols: 40, rows: 3, scrollback: 100, allowProposedApi: true })
  terminals.push(term)
  // An unopened engine has no selection service; the addon selects each match it steps to.
  vi.spyOn(term, 'select').mockImplementation(() => {})
  vi.spyOn(term, 'clearSelection').mockImplementation(() => {})
  await new Promise<void>((resolve) => term.write(text, resolve))
  const addon = new SearchAddon()
  const posted: Record<string, unknown>[] = []
  const scope = createTerminalDocumentScope({
    createSearchAddon: () => addon,
    postToHost: (message) => posted.push(message)
  })
  const attach = () => attachSearchAddon(scope, { loadAddon: () => term.loadAddon(addon) })
  if (attached) {
    attach()
  }
  const lastResults = () => posted.findLast((message) => message.type === 'find-results')
  return { scope, attach, posted, lastResults }
}

describe('terminal document find', () => {
  it('counts every match in the scrollback and reports none once cleared', async () => {
    const doc = await searchableDocument(
      'alpha one\r\nbeta\r\ngamma alpha\r\ndelta\r\nepsilon\r\nalpha end\r\n'
    )

    handleMsg(doc.scope, { type: 'find', query: 'alpha', direction: 'next', incremental: true })
    expect(doc.lastResults()).toEqual({ type: 'find-results', resultIndex: 0, resultCount: 3 })

    handleMsg(doc.scope, { type: 'clear-find' })
    expect(doc.lastResults()).toEqual({ type: 'find-results', resultIndex: -1, resultCount: 0 })
  })

  it('replays a find sent before the engine had its addon once init attaches one', async () => {
    const doc = await searchableDocument('alpha\r\nbeta alpha\r\n', { attached: false })

    handleMsg(doc.scope, { type: 'find', query: 'alpha', direction: 'next', incremental: true })
    expect(doc.lastResults()).toBeUndefined()

    doc.attach()
    rerunTerminalFind(doc.scope)
    expect(doc.lastResults()).toEqual({ type: 'find-results', resultIndex: 0, resultCount: 2 })
  })

  it('drops a long-press selection and its handles when a search takes the selection', async () => {
    const doc = await searchableDocument('alpha\r\nbeta alpha\r\n')
    const overlay = document.createElement('div')
    overlay.classList.add('active')
    doc.scope.selectionOverlay = overlay
    doc.scope.selMode = 'select'
    doc.scope.sel = { anchor: { col: 0, row: 1 }, focus: { col: 3, row: 1 }, activeHandle: null }

    handleMsg(doc.scope, { type: 'find', query: 'alpha', direction: 'next', incremental: true })

    expect(doc.scope.selMode).toBe('navigate')
    expect(doc.scope.sel).toBeNull()
    expect(overlay.classList.contains('active')).toBe(false)
    expect(doc.posted).toContainEqual({ type: 'set-select-mode', enabled: false })
  })
})
