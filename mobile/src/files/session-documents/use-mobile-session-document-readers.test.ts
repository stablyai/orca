import { describe, expect, it, vi } from 'vitest'
import { hookMount, performHookAction } from '../../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import type { MarkdownDocState } from './session-document-state'
import { useMobileSessionDocumentReaders } from './use-mobile-session-document-readers'

const META = { runtimeId: 'runtime-1' }

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
})
