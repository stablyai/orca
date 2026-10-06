import { describe, expect, it, vi } from 'vitest'
import { hookMount, performHookAction } from '../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcResponse } from '../transport/types'
import type { MarkdownDocState } from './mobile-session-route-types'
import { useMobileSessionDocumentReaders } from './use-mobile-session-document-readers'

const META = { runtimeId: 'runtime-1' }

async function readMarkdown(reply: RpcResponse): Promise<MarkdownDocState | undefined> {
  let docs = new Map<string, MarkdownDocState>()
  let readers: ReturnType<typeof useMobileSessionDocumentReaders> | undefined
  const hook = hookMount(() => {
    readers = useMobileSessionDocumentReaders(
      mountFixture<Parameters<typeof useMobileSessionDocumentReaders>[0]>({
        worktreeId: 'wt-1',
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
