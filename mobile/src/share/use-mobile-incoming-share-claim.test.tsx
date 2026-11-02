import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PickedMobileFile, PickedMobileImage } from '../platform/media-picker-contract'

// The share's cache copies, read through expo-file-system's File like any picked file.
const cacheFiles = vi.hoisted(() => new Map<string, Uint8Array>())
vi.mock('expo-image-picker', () => ({}))
vi.mock('expo-document-picker', () => ({}))
vi.mock('expo-file-system', () => ({
  File: class {
    private readonly bytes: Uint8Array
    constructor(uri: string) {
      this.bytes = cacheFiles.get(uri) ?? new Uint8Array()
    }
    get size(): number {
      return this.bytes.byteLength
    }
    open() {
      let read = false
      return {
        size: this.bytes.byteLength,
        readBytes: () => {
          const chunk = read ? new Uint8Array() : this.bytes
          read = true
          return chunk
        },
        close: () => {}
      }
    }
  }
}))

const { useMobileNativeChatDrafts } =
  await import('../session/native-chat/composer/use-mobile-native-chat-drafts')
const { resetMobileNativeChatDraftStoreForTests, useMobileNativeChatDraft } =
  await import('../session/native-chat/composer/mobile-native-chat-draft-store')
const { offerIncomingShare, takeIncomingShare } = await import('./incoming-share')
const { useMobileIncomingShareClaim } = await import('./use-mobile-incoming-share-claim')

const photo = {
  uri: 'file:///cache/PXL_0042.jpg',
  mimeType: 'image/jpeg',
  name: 'PXL_0042.jpg',
  size: 3
}
const paper = {
  uri: 'file:///cache/paper.pdf',
  mimeType: 'application/pdf',
  name: 'paper.pdf',
  size: 4
}

type Session = {
  composerVisible?: boolean
  canAttach?: boolean
  acceptsImages?: boolean
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of items) {
    out.push(item)
  }
  return out
}

describe('useMobileIncomingShareClaim', () => {
  let renderer: ReactTestRenderer | null = null
  let draft = ''
  let setDraft: ((text: string) => void) | null = null
  const attachedImages: Promise<PickedMobileImage[]>[] = []
  const savedFiles: PickedMobileFile[] = []
  const toasts: string[] = []

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    resetMobileNativeChatDraftStoreForTests()
    takeIncomingShare()
    cacheFiles.clear()
    attachedImages.length = 0
    savedFiles.length = 0
    toasts.length = 0
  })

  function ChatSession({
    composerVisible = true,
    canAttach = true,
    acceptsImages = true
  }: Session) {
    const drafts = useMobileNativeChatDrafts({
      hostId: 'mac',
      worktreeId: 'myogen',
      tabId: 'claude',
      sessionId: 'session-1',
      messages: [],
      transcriptSettled: true
    })
    draft = useMobileNativeChatDraft(drafts.draftKey)
    setDraft = drafts.setComposerText
    useMobileIncomingShareClaim({
      composerVisible,
      canAttach,
      acceptsImages,
      appendText: drafts.appendComposerText,
      attachImages: async (picked) => {
        attachedImages.push(collect(picked))
      },
      saveDocument: async (file) => {
        savedFiles.push(file)
        return `docs/${file.name}`
      },
      showToast: (message) => toasts.push(message)
    })
    return null
  }

  // Render, then let the claim's take settle.
  async function render(session: Session = {}) {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(ChatSession, session))
      } else {
        renderer = create(createElement(ChatSession, session))
      }
    })
  }

  function leave() {
    act(() => renderer?.unmount())
    renderer = null
  }

  it('adds a shared URL below the existing draft exactly once across remounts', async () => {
    await render()
    act(() => setDraft?.('Check this'))
    leave()
    offerIncomingShare({ text: 'https://example.com', files: [] })
    await render()
    expect(draft).toBe('Check this\nhttps://example.com')

    leave()
    await render()
    await render()
    expect(draft).toBe('Check this\nhttps://example.com')
  })

  it('leaves a share that arrives in an open chat for the destination picker', async () => {
    await render()
    await act(async () => offerIncomingShare({ text: 'https://example.com', files: [] }))
    expect(draft).toBe('')

    // Home opens; the chat the user then picks takes it.
    leave()
    await render()
    expect(draft).toBe('https://example.com')
  })

  it('waits until the chat is on screen and can upload, then takes text and photo together', async () => {
    cacheFiles.set(photo.uri, new Uint8Array([1, 2, 3]))
    offerIncomingShare({ text: 'look', files: [photo] })
    await render({ composerVisible: false })
    await render({ canAttach: false })
    expect(draft).toBe('')
    expect(attachedImages).toHaveLength(0)

    await render()
    expect(draft).toBe('look')
    expect(await Promise.all(attachedImages)).toEqual([[{ base64: 'AQID', uri: photo.uri }]])
  })

  it('saves a shared document into the workspace and mentions it below the text', async () => {
    cacheFiles.set(paper.uri, new Uint8Array([37, 80, 68, 70]))
    offerIncomingShare({ text: 'cite?', files: [paper] })
    await render()

    expect(savedFiles).toEqual([
      { name: 'paper.pdf', mime: 'application/pdf', byteLength: 4, base64: 'JVBERg==' }
    ])
    expect(draft).toBe('cite?\n@docs/paper.pdf')
  })

  it('says so when the session cannot take a shared photo, keeping the rest', async () => {
    cacheFiles.set(photo.uri, new Uint8Array([1, 2, 3]))
    offerIncomingShare({ text: 'look', files: [photo] })
    await render({ acceptsImages: false })

    expect(draft).toBe('look')
    expect(attachedImages).toHaveLength(0)
    expect(toasts).toHaveLength(1)
  })
})
