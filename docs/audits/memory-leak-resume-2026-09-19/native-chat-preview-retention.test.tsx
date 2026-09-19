// Audit evidence: asserts the current leak, not desired regression-test behavior.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob, resolveObjectURL } from 'node:buffer'
import { URL as NodeURL } from 'node:url'
import { act, createElement, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache,
  useNativeChatComposerAttachments
} from '../../../src/renderer/src/components/native-chat/use-native-chat-composer-attachments'
import type { NativeChatResolvedTarget } from '../../../src/renderer/src/components/native-chat/native-chat-composer-target'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false
}))

const target: NativeChatResolvedTarget = {
  ptyId: 'pty-1',
  settings: { activeRuntimeEnvironmentId: null }
}
const CYCLE_COUNT = 10
const BLOB_BYTES = 1024
type AttachmentApi = ReturnType<typeof useNativeChatComposerAttachments>
type RegistryProbe = {
  retainedBytes: () => number
  cleanup: () => void
}
let activeRegistry: RegistryProbe | null = null

function Probe({
  scopeKey,
  onReady
}: {
  scopeKey: string
  onReady: (api: AttachmentApi) => void
}): React.JSX.Element {
  const [caret, setCaret] = useState(0)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const api = useNativeChatComposerAttachments({
    attachmentScopeKey: scopeKey,
    caret,
    disabled: false,
    isComposing: () => false,
    resolveTarget: () => target,
    textareaRef,
    setCaret,
    setDraft: (updater) => setDraft((previous) => updater(previous)),
    setNotice
  })
  useEffect(() => onReady(api), [api, onReady])
  void draft
  void notice
  return createElement('textarea', { ref: textareaRef })
}

async function mountProbe(scopeKey: string): Promise<{ root: Root; api: () => AttachmentApi }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let latest: AttachmentApi | null = null
  const onReady = (api: AttachmentApi): void => {
    latest = api
  }
  await act(async () => {
    root.render(createElement(Probe, { scopeKey, onReady }))
  })
  if (!latest) {
    throw new Error('temporary attachment probe did not mount')
  }
  return {
    root,
    api: () => {
      if (!latest) {
        throw new Error('temporary attachment probe is unmounted')
      }
      return latest
    }
  }
}

function installUrlRegistryProbe(): RegistryProbe {
  const retainedUrls = new Set<string>()
  const browserUrl = globalThis.URL
  const create = NodeURL.createObjectURL.bind(NodeURL)
  const revoke = NodeURL.revokeObjectURL.bind(NodeURL)
  vi.spyOn(browserUrl, 'createObjectURL').mockImplementation((blob: Blob) => {
    const url = create(blob)
    retainedUrls.add(url)
    return url
  })
  vi.spyOn(browserUrl, 'revokeObjectURL').mockImplementation((url: string) => {
    retainedUrls.delete(url)
    revoke(url)
  })
  return {
    retainedBytes: () =>
      [...retainedUrls].reduce((total, url) => total + (resolveObjectURL(url)?.size ?? 0), 0),
    cleanup: () => {
      for (const url of retainedUrls) {
        revoke(url)
      }
      retainedUrls.clear()
    }
  }
}

function makePreviewUrl(): string {
  return globalThis.URL.createObjectURL(new Blob([Buffer.alloc(BLOB_BYTES)]))
}

function requireAttachmentId(id: string | null): string {
  if (!id) {
    throw new Error('temporary attachment probe did not return an id')
  }
  return id
}

describe('native-chat Blob URL ownership evidence', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  afterEach(() => {
    activeRegistry?.cleanup()
    activeRegistry = null
    clearNativeChatAttachmentCacheForTests()
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('measures pending and settled unmount retention against removal controls', async () => {
    const registry = installUrlRegistryProbe()
    activeRegistry = registry
    for (let cycle = 0; cycle < CYCLE_COUNT; cycle += 1) {
      const probe = await mountProbe(`settled-${cycle}`)
      let id: string | null = null
      await act(async () => {
        id = probe.api().beginPendingImageAttachment(makePreviewUrl())
        probe
          .api()
          .resolvePendingImageAttachment(requireAttachmentId(id), `/tmp/settled-${cycle}.png`)
      })
      act(() => probe.root.unmount())
    }
    const settledUnmountRetainedBytes = registry.retainedBytes()
    expect(settledUnmountRetainedBytes).toBe(CYCLE_COUNT * BLOB_BYTES)

    const remounted = await mountProbe('settled-0')
    const remountedCache = readNativeChatAttachmentCache('settled-0')
    expect(remounted.api().imageAttachments).toMatchObject([{ path: '/tmp/settled-0.png' }])
    expect(remountedCache.every((attachment) => attachment.previewUrl === undefined)).toBe(true)
    act(() => remounted.root.unmount())

    const pending = await mountProbe('pending')
    await act(async () => {
      pending.api().beginPendingImageAttachment(makePreviewUrl())
    })
    act(() => pending.root.unmount())
    const pendingUnmountRetainedBytes = registry.retainedBytes()
    expect(pendingUnmountRetainedBytes).toBe((CYCLE_COUNT + 1) * BLOB_BYTES)

    const remove = await mountProbe('remove')
    let removeId: string | null = null
    await act(async () => {
      removeId = remove.api().beginPendingImageAttachment(makePreviewUrl())
      remove.api().resolvePendingImageAttachment(requireAttachmentId(removeId), '/tmp/remove.png')
    })
    const beforeRemove = registry.retainedBytes()
    act(() => remove.api().removeImageAttachment(requireAttachmentId(removeId)))
    expect(registry.retainedBytes()).toBe(beforeRemove - BLOB_BYTES)
    const afterRemove = registry.retainedBytes()
    act(() => remove.root.unmount())

    const clear = await mountProbe('clear')
    await act(async () => {
      clear.api().beginPendingImageAttachment(makePreviewUrl())
      clear.api().beginPendingImageAttachment(makePreviewUrl())
    })
    const beforeClear = registry.retainedBytes()
    act(() => clear.api().clearImageAttachments())
    expect(registry.retainedBytes()).toBe(beforeClear - 2 * BLOB_BYTES)
    const afterClear = registry.retainedBytes()
    act(() => clear.root.unmount())

    console.log(
      JSON.stringify({
        cycleCount: CYCLE_COUNT,
        blobBytesPerCycle: BLOB_BYTES,
        settledUnmountRetainedBytes,
        pendingUnmountRetainedBytes,
        remountedCachePreviewUrls: remountedCache.map(
          (attachment) => attachment.previewUrl ?? null
        ),
        removeControlRevokedBytes: beforeRemove - afterRemove,
        clearControlRevokedBytes: beforeClear - afterClear
      })
    )
  })
})
