import { describe, expect, it } from 'vitest'
import type { MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'
import { MobileSessionMarkdownDocLifecycle } from './mobile-session-markdown-doc-lifecycle'

type MarkdownTab = Extract<MobileSessionTab, { type: 'markdown' }>
type ReadyMarkdownDoc = Extract<MarkdownDocState, { status: 'ready' }>

function markdownTab(id: string, relativePath = `${id}.md`): MarkdownTab {
  return {
    type: 'markdown',
    id,
    title: relativePath,
    filePath: `/repo/${relativePath}`,
    relativePath,
    isDirty: false,
    isActive: false,
    documentVersion: 'v1'
  }
}

function readyDoc(content: string, isDirty = false): ReadyMarkdownDoc {
  return {
    status: 'ready',
    content,
    localContent: content,
    baseVersion: 'v1',
    isDirty,
    editable: true
  }
}

describe('mobile session markdown document lifecycle', () => {
  it('retains payloads only for markdown tabs in the accepted snapshot', () => {
    const lifecycle = new MobileSessionMarkdownDocLifecycle()
    let docs = new Map<string, MarkdownDocState>([
      ['closed', readyDoc('x'.repeat(1_000_000))],
      ['live', readyDoc('live')]
    ])

    lifecycle.reconcile([markdownTab('live')], (update) => {
      docs = update(docs)
    })

    expect([...docs.keys()]).toEqual(['live'])
  })

  it('retains a dirty orphan when reconciliation keeps its draft tab', () => {
    const lifecycle = new MobileSessionMarkdownDocLifecycle()
    let docs = new Map<string, MarkdownDocState>([['draft', readyDoc('unsaved', true)]])

    lifecycle.reconcile([markdownTab('draft')], (update) => {
      docs = update(docs)
    })

    expect(docs.get('draft')).toEqual(readyDoc('unsaved', true))
  })

  it('does not let a late read resurrect a closed tab', async () => {
    const lifecycle = new MobileSessionMarkdownDocLifecycle()
    const tab = markdownTab('late')
    let docs = new Map<string, MarkdownDocState>()
    const updateDocs = (update: (current: typeof docs) => typeof docs) => {
      docs = update(docs)
    }
    lifecycle.reconcile([tab], updateDocs)
    let resolveRead: (doc: ReadyMarkdownDoc) => void = () => undefined
    const read = new Promise<ReadyMarkdownDoc>((resolve) => {
      resolveRead = resolve
    })

    const pending = lifecycle.load(tab, updateDocs, () => read)
    docs = lifecycle.close(tab.id, docs)
    resolveRead(readyDoc('late payload'))
    await pending

    expect(docs.size).toBe(0)
  })

  it('does not let an old path overwrite a replacement using the same tab id', async () => {
    const lifecycle = new MobileSessionMarkdownDocLifecycle()
    const oldTab = markdownTab('same', 'old.md')
    let docs = new Map<string, MarkdownDocState>()
    const updateDocs = (update: (current: typeof docs) => typeof docs) => {
      docs = update(docs)
    }
    lifecycle.reconcile([oldTab], updateDocs)
    let resolveRead: (doc: ReadyMarkdownDoc) => void = () => undefined
    const pending = lifecycle.load(
      oldTab,
      updateDocs,
      () =>
        new Promise<ReadyMarkdownDoc>((resolve) => {
          resolveRead = resolve
        })
    )

    lifecycle.reconcile([markdownTab('same', 'new.md')], updateDocs)
    resolveRead(readyDoc('old payload'))
    await pending

    expect(docs.size).toBe(0)
  })

  it('names the failing code in the retry state', async () => {
    const lifecycle = new MobileSessionMarkdownDocLifecycle()
    const tab = markdownTab('tab')
    let docs = new Map<string, MarkdownDocState>()
    const updateDocs = (update: (current: typeof docs) => typeof docs) => {
      docs = update(docs)
    }
    lifecycle.reconcile([tab], updateDocs)

    await lifecycle.load(tab, updateDocs, () => Promise.reject(new Error('host_error')))

    expect(docs.get('tab')).toEqual({
      status: 'error',
      message: "Couldn't load markdown: host_error"
    })
  })

  it('keeps the plain message when the failure carries prose', async () => {
    const lifecycle = new MobileSessionMarkdownDocLifecycle()
    const tab = markdownTab('tab')
    let docs = new Map<string, MarkdownDocState>()
    const updateDocs = (update: (current: typeof docs) => typeof docs) => {
      docs = update(docs)
    }
    lifecycle.reconcile([tab], updateDocs)

    await lifecycle.load(tab, updateDocs, () =>
      Promise.reject(new Error('Unable to read markdown'))
    )

    expect(docs.get('tab')).toEqual({ status: 'error', message: "Couldn't load markdown" })
  })
})
