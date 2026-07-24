import { describe, expect, it } from 'vitest'
import {
  MobileSessionFileDocLifecycle,
  beginMobileFileDocLoad,
  createMobileFileDocLifecycle,
  finishMobileFileDocLoad,
  forgetMobileFileDocTab,
  reconcileMobileFileDocTabs,
  removeMobileFileDoc,
  resetMobileFileDocLifecycle,
  retainLiveMobileFileDocs,
  type MobileFileTabIdentity
} from './mobile-session-file-doc-lifecycle'
import type { MobileFileTabDoc } from '../files/mobile-file-tab-doc'

type TestFileDoc = MobileFileTabDoc | { status: 'loading' } | { status: 'error'; message: string }

function fileTab(id: string, relativePath = `${id}.ts`): MobileFileTabIdentity {
  return {
    id,
    filePath: `/repo/${relativePath}`,
    relativePath,
    mode: 'edit'
  }
}

describe('mobile session file document lifecycle', () => {
  it('retains payloads only for file tabs in the accepted live snapshot', () => {
    const lifecycle = createMobileFileDocLifecycle()
    reconcileMobileFileDocTabs(lifecycle, [fileTab('live-a'), fileTab('live-b')])
    const docs = new Map([
      ['closed', { payload: 'x'.repeat(1_000_000) }],
      ['live-a', { payload: 'a' }],
      ['live-b', { payload: 'b' }]
    ])

    const retained = retainLiveMobileFileDocs(docs, lifecycle)

    expect([...retained.keys()]).toEqual(['live-a', 'live-b'])
    expect(retained.get('live-a')).toBe(docs.get('live-a'))
  })

  it('deletes a successfully closed tab immediately', () => {
    const lifecycle = createMobileFileDocLifecycle()
    reconcileMobileFileDocTabs(lifecycle, [fileTab('closed')])
    forgetMobileFileDocTab(lifecycle, 'closed')

    expect(removeMobileFileDoc(new Map([['closed', { payload: 'large' }]]), 'closed').size).toBe(0)
  })

  it('rejects a late read after its tab closes', () => {
    const lifecycle = createMobileFileDocLifecycle()
    const tab = fileTab('file')
    reconcileMobileFileDocTabs(lifecycle, [tab])
    const token = beginMobileFileDocLoad(lifecycle, tab)
    expect(token).not.toBeNull()

    forgetMobileFileDocTab(lifecycle, tab.id)

    expect(finishMobileFileDocLoad(lifecycle, token!)).toBe(false)
  })

  it('keeps route state empty when a read resolves after close', async () => {
    const lifecycle = new MobileSessionFileDocLifecycle()
    const tab = fileTab('file')
    let docs = new Map<string, TestFileDoc>()
    const updateDocs = (update: (current: typeof docs) => typeof docs) => {
      docs = update(docs)
    }
    lifecycle.reconcile([{ ...tab, type: 'file' }], updateDocs)
    let resolveRead: (doc: MobileFileTabDoc) => void = () => undefined
    const read = new Promise<MobileFileTabDoc>((resolve) => {
      resolveRead = resolve
    })

    const pending = lifecycle.load(tab, updateDocs, () => read)
    expect(docs.get(tab.id)).toEqual({ status: 'loading' })
    lifecycle.close(tab.id, updateDocs)
    resolveRead({ status: 'ready', kind: 'file', content: 'late', truncated: false, byteLength: 4 })
    await pending

    expect(docs.size).toBe(0)
  })

  it('rejects a late read when the same tab id is replaced with another file', () => {
    const lifecycle = createMobileFileDocLifecycle()
    const oldTab = fileTab('file', 'old.ts')
    reconcileMobileFileDocTabs(lifecycle, [oldTab])
    const token = beginMobileFileDocLoad(lifecycle, oldTab)
    expect(token).not.toBeNull()

    const replaced = reconcileMobileFileDocTabs(lifecycle, [fileTab('file', 'replacement.ts')])

    expect(finishMobileFileDocLoad(lifecycle, token!)).toBe(false)
    expect(
      retainLiveMobileFileDocs(
        new Map([['file', { payload: 'old contents' }]]),
        lifecycle,
        replaced
      )
    ).toEqual(new Map())
  })

  it('lets only the newest read for a live tab commit', () => {
    const lifecycle = createMobileFileDocLifecycle()
    const tab = fileTab('file')
    reconcileMobileFileDocTabs(lifecycle, [tab])
    const first = beginMobileFileDocLoad(lifecycle, tab)
    const second = beginMobileFileDocLoad(lifecycle, tab)

    expect(finishMobileFileDocLoad(lifecycle, first!)).toBe(false)
    expect(finishMobileFileDocLoad(lifecycle, second!)).toBe(true)
  })

  it('invalidates requests when the route scope resets even if tab ids are reused', () => {
    const lifecycle = createMobileFileDocLifecycle()
    const tab = fileTab('reused')
    reconcileMobileFileDocTabs(lifecycle, [tab])
    const oldScope = beginMobileFileDocLoad(lifecycle, tab)

    resetMobileFileDocLifecycle(lifecycle)
    reconcileMobileFileDocTabs(lifecycle, [tab])
    const newScope = beginMobileFileDocLoad(lifecycle, tab)

    expect(finishMobileFileDocLoad(lifecycle, oldScope!)).toBe(false)
    expect(finishMobileFileDocLoad(lifecycle, newScope!)).toBe(true)
  })
})
