import { describe, expect, it, vi } from 'vitest'
import { hookMount, performHookAction } from '../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcResponse } from '../transport/types'
import type { FileDocState, MarkdownDocState } from './mobile-session-route-types'
import { useMobileSessionDocumentReaders } from './use-mobile-session-document-readers'

const META = { runtimeId: 'runtime-1' }

async function readMarkdown(reply: RpcResponse): Promise<MarkdownDocState | undefined> {
  let docs = new Map<string, MarkdownDocState>()
  let readers: ReturnType<typeof useMobileSessionDocumentReaders> | undefined
  const hook = hookMount(() => {
    readers = useMobileSessionDocumentReaders(
      mountFixture<Parameters<typeof useMobileSessionDocumentReaders>[0]>({
        worktreeId: 'wt-1',
        markdownDocsRef: {
          get current() {
            return docs
          }
        },
        client: { sendRequest: vi.fn(async (): Promise<RpcResponse> => reply) },
        setMarkdownDocs: (update) => {
          docs = typeof update === 'function' ? update(docs) : update
        },
        setFileDocs: () => {}
      })
    )
  })
  hook.mount()
  await performHookAction(() =>
    readers?.readMarkdownTab(
      mountFixture<Parameters<typeof readers.readMarkdownTab>[0]>({
        type: 'markdown',
        id: 'tab-md',
        relativePath: 'README.md',
        isDirty: false
      })
    )
  )
  hook.unmount()
  return docs.get('tab-md')
}

async function readFile(
  relativePath: string,
  reply: RpcResponse
): Promise<FileDocState | undefined> {
  let docs = new Map<string, FileDocState>()
  let readers: ReturnType<typeof useMobileSessionDocumentReaders> | undefined
  const hook = hookMount(() => {
    readers = useMobileSessionDocumentReaders(
      mountFixture<Parameters<typeof useMobileSessionDocumentReaders>[0]>({
        worktreeId: 'wt-1',
        client: { sendRequest: vi.fn(async (): Promise<RpcResponse> => reply) },
        setMarkdownDocs: () => {},
        setFileDocs: (update) => {
          docs = typeof update === 'function' ? update(docs) : update
        }
      })
    )
  })
  hook.mount()
  await performHookAction(() =>
    readers?.readFileTab(
      mountFixture<Parameters<typeof readers.readFileTab>[0]>({
        type: 'file',
        id: 'tab-file',
        relativePath,
        isDirty: false
      })
    )
  )
  hook.unmount()
  return docs.get('tab-file')
}

describe('useMobileSessionDocumentReaders file reads', () => {
  it('explains a desktop tab of a file outside the workspace instead of a generic failure', async () => {
    const doc = await readFile('/other/report.txt', {
      id: 'frame-1',
      ok: false,
      error: { code: 'runtime_error', message: 'invalid_relative_path' },
      _meta: META
    })
    expect(doc).toEqual({
      status: 'error',
      message: 'This file is outside the workspace. Open it on desktop to view it.'
    })
  })
})

function readTabResult(extra: Record<string, unknown> = {}): RpcResponse {
  return {
    id: 'frame-1',
    ok: true,
    result: {
      tabId: 'tab-md',
      content: '# head',
      version: 'content:6:0',
      isDirty: false,
      editable: false,
      readOnlyReason: 'file_too_large',
      ...extra
    },
    _meta: META
  }
}

describe('useMobileSessionDocumentReaders markdown reads', () => {
  it('shows an older desktop refusing an oversize file as too large', async () => {
    const doc = await readMarkdown({
      id: 'frame-1',
      ok: false,
      error: { code: 'runtime_error', message: 'file_too_large' },
      _meta: META
    })
    expect(doc).toEqual({ status: 'error', message: 'File too large for mobile preview' })
  })

  it('keeps the generic message for an unknown refusal', async () => {
    const doc = await readMarkdown({
      id: 'frame-1',
      ok: false,
      error: { code: 'tab_not_found', message: 'No such tab' },
      _meta: META
    })
    expect(doc).toEqual({ status: 'error', message: "Couldn't load markdown" })
  })

  it('carries a truncated prefix and the full size into the document', async () => {
    const doc = await readMarkdown(readTabResult({ truncated: true, byteLength: 3_000_000 }))
    expect(doc).toMatchObject({
      status: 'ready',
      content: '# head',
      editable: false,
      truncated: true,
      byteLength: 3_000_000
    })
  })

  it('adds no truncation fields for a whole document', async () => {
    const doc = await readMarkdown(readTabResult())
    expect(doc).toMatchObject({ status: 'ready', content: '# head' })
    expect(doc).not.toHaveProperty('truncated')
    expect(doc).not.toHaveProperty('byteLength')
  })
})

function readyMarkdown(
  content: string,
  extra: Partial<Extract<MarkdownDocState, { status: 'ready' }>> = {}
): Extract<MarkdownDocState, { status: 'ready' }> {
  return {
    status: 'ready',
    content,
    localContent: content,
    baseVersion: 'v1',
    isDirty: false,
    editable: true,
    stale: false,
    ...extra
  }
}

function deferredReply() {
  let resolve: (reply: RpcResponse) => void = () => {}
  const promise = new Promise<RpcResponse>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function mountMarkdownReads(
  initial: Map<string, MarkdownDocState>,
  sendRequest: (method: string) => Promise<RpcResponse>
) {
  let docs = new Map(initial)
  const published: MarkdownDocState[] = []
  let readers: ReturnType<typeof useMobileSessionDocumentReaders> | undefined
  const hook = hookMount(() => {
    readers = useMobileSessionDocumentReaders(
      mountFixture<Parameters<typeof useMobileSessionDocumentReaders>[0]>({
        worktreeId: 'wt-1',
        markdownDocsRef: {
          get current() {
            return docs
          }
        },
        client: { sendRequest: vi.fn(sendRequest) },
        setMarkdownDocs: (update) => {
          const next = typeof update === 'function' ? update(docs) : update
          const doc = next.get('tab-md')
          if (doc && doc !== docs.get('tab-md')) {
            published.push(doc)
          }
          docs = next
        },
        setFileDocs: () => {}
      })
    )
  })
  hook.mount()
  const tab = mountFixture<Parameters<NonNullable<typeof readers>['readMarkdownTab']>[0]>({
    type: 'markdown',
    id: 'tab-md',
    relativePath: 'README.md',
    isDirty: false
  })
  return {
    published,
    get docs() {
      return docs
    },
    read: () => performHookAction(() => readers?.readMarkdownTab(tab)),
    unmount: hook.unmount
  }
}

describe('useMobileSessionDocumentReaders markdown revalidation', () => {
  it.each([
    {
      reply: { editable: false, readOnlyReason: 'host_read_only' },
      expected: { editable: false, readOnlyReason: 'host_read_only' }
    },
    { reply: { isDirty: true }, expected: { stale: true } },
    {
      reply: { truncated: true, byteLength: 3_000_000 },
      expected: { truncated: true, byteLength: 3_000_000 }
    }
  ])(
    'applies metadata changes with unchanged content and version: $expected',
    async ({ reply, expected }) => {
      const initial = readyMarkdown('# head')
      const harness = mountMarkdownReads(new Map([['tab-md', initial]]), async () =>
        readTabResult({
          content: '# head',
          version: 'v1',
          editable: true,
          readOnlyReason: undefined,
          ...reply
        })
      )
      try {
        await harness.read()
        expect(harness.docs.get('tab-md')).toMatchObject(expected)
      } finally {
        harness.unmount()
      }
    }
  )

  it('does not overwrite a phone save that finishes during a background read', async () => {
    const initial = readyMarkdown('# head')
    const pending = deferredReply()
    const harness = mountMarkdownReads(new Map([['tab-md', initial]]), () => pending.promise)
    try {
      const reading = harness.read()
      const saved = readyMarkdown('saved phone draft', { baseVersion: 'v3' })
      harness.docs.set('tab-md', saved)
      pending.resolve(readTabResult({ content: '# older server text', version: 'v2' }))
      await reading
      expect(harness.docs.get('tab-md')).toBe(saved)
    } finally {
      harness.unmount()
    }
  })

  it('keeps a clean document mounted when the reread is unchanged', async () => {
    const initial = readyMarkdown('# head')
    const harness = mountMarkdownReads(new Map([['tab-md', initial]]), async () =>
      readTabResult({ content: '# head', version: 'v1', editable: true, readOnlyReason: undefined })
    )
    try {
      await harness.read()
      expect(harness.published).toEqual([])
      expect(harness.docs.get('tab-md')).toBe(initial)
    } finally {
      harness.unmount()
    }
  })

  it('updates a clean document in place when desktop content changed', async () => {
    const initial = readyMarkdown('# head')
    const harness = mountMarkdownReads(new Map([['tab-md', initial]]), async () =>
      readTabResult({ content: '# next', version: 'v2' })
    )
    try {
      await harness.read()
      expect(harness.published.map((doc) => doc.status)).toEqual(['ready'])
      expect(harness.docs.get('tab-md')).toMatchObject({
        status: 'ready',
        content: '# next',
        localContent: '# next',
        baseVersion: 'v2',
        isDirty: false
      })
    } finally {
      harness.unmount()
    }
  })

  it('keeps the visible document when a reread fails', async () => {
    const initial = readyMarkdown('# head')
    const harness = mountMarkdownReads(new Map([['tab-md', initial]]), async () => ({
      id: 'frame-1',
      ok: false,
      error: { code: 'tab_not_found', message: 'No such tab' },
      _meta: META
    }))
    try {
      await harness.read()
      expect(harness.published).toEqual([])
      expect(harness.docs.get('tab-md')).toBe(initial)
    } finally {
      harness.unmount()
    }
  })

  it('drops a reread that loses to an edit made while it was in flight', async () => {
    const initial = readyMarkdown('# head')
    const pending = deferredReply()
    const harness = mountMarkdownReads(new Map([['tab-md', initial]]), () => pending.promise)
    try {
      const reading = harness.read()
      const current = harness.docs.get('tab-md')
      if (current?.status !== 'ready') {
        throw new Error('Expected the clean document to stay visible')
      }
      harness.docs.set('tab-md', { ...current, localContent: 'phone draft', isDirty: true })
      pending.resolve(readTabResult({ content: '# server', version: 'v2' }))
      await reading
      expect(harness.docs.get('tab-md')).toMatchObject({
        status: 'ready',
        content: '# head',
        localContent: 'phone draft',
        isDirty: true
      })
      expect(harness.published.every((doc) => doc.status !== 'loading')).toBe(true)
    } finally {
      harness.unmount()
    }
  })

  it('reloads a dirty document instead of keeping the draft', async () => {
    const initial = readyMarkdown('# head', { localContent: 'phone draft', isDirty: true })
    const harness = mountMarkdownReads(new Map([['tab-md', initial]]), async () =>
      readTabResult({ content: '# server', version: 'v2' })
    )
    try {
      await harness.read()
      expect(harness.published.map((doc) => doc.status)).toEqual(['loading', 'ready'])
      expect(harness.docs.get('tab-md')).toMatchObject({
        status: 'ready',
        content: '# server',
        localContent: '# server',
        isDirty: false
      })
    } finally {
      harness.unmount()
    }
  })

  it.each([
    ['changed', '# new', 'v2'],
    ['unchanged', '# head', 'v1']
  ] as const)(
    'keeps the newer reread when an older one finishes later: %s content',
    async (kind, content, version) => {
      const initial = readyMarkdown('# head')
      const older = deferredReply()
      let calls = 0
      const harness = mountMarkdownReads(new Map([['tab-md', initial]]), () => {
        calls += 1
        return calls === 1
          ? older.promise
          : Promise.resolve(
              readTabResult({ content, version, editable: true, readOnlyReason: undefined })
            )
      })
      try {
        const first = harness.read()
        const second = harness.read()
        await second
        const current = harness.docs.get('tab-md')
        older.resolve(readTabResult({ content: '# old', version: 'v0' }))
        await first
        expect(harness.docs.get('tab-md')).toBe(current)
        expect(current).toMatchObject({ content, baseVersion: version })
        if (kind === 'unchanged') {
          expect(current).toBe(initial)
        }
        expect(harness.published.every((doc) => doc.status !== 'loading')).toBe(true)
      } finally {
        harness.unmount()
      }
    }
  )

  it('updates from disk without unmounting when the desktop renderer is down', async () => {
    const initial = readyMarkdown('# head')
    const harness = mountMarkdownReads(new Map([['tab-md', initial]]), async (method) =>
      method === 'files.read'
        ? {
            id: 'frame-2',
            ok: true,
            result: { content: '# disk' },
            _meta: META
          }
        : {
            id: 'frame-1',
            ok: false,
            error: { code: 'runtime_error', message: 'renderer_unavailable' },
            _meta: META
          }
    )
    try {
      await harness.read()
      expect(harness.published.map((doc) => doc.status)).toEqual(['ready'])
      expect(harness.docs.get('tab-md')).toMatchObject({
        status: 'ready',
        content: '# disk',
        editable: false
      })
    } finally {
      harness.unmount()
    }
  })

  it('keeps the visible document when disk fallback fails too', async () => {
    const initial = readyMarkdown('# head')
    const harness = mountMarkdownReads(new Map([['tab-md', initial]]), async () => ({
      id: 'frame-1',
      ok: false,
      error: { code: 'runtime_error', message: 'renderer_unavailable' },
      _meta: META
    }))
    try {
      await harness.read()
      expect(harness.published).toEqual([])
      expect(harness.docs.get('tab-md')).toBe(initial)
    } finally {
      harness.unmount()
    }
  })

  it('does not restore a document closed while a reread was in flight', async () => {
    const initial = readyMarkdown('# head')
    const pending = deferredReply()
    const harness = mountMarkdownReads(new Map([['tab-md', initial]]), () => pending.promise)
    try {
      const reading = harness.read()
      harness.docs.delete('tab-md')
      pending.resolve(readTabResult({ content: '# late', version: 'v2' }))
      await reading
      expect(harness.docs.has('tab-md')).toBe(false)
    } finally {
      harness.unmount()
    }
  })
})
