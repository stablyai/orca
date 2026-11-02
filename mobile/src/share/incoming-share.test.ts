import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncomingSharePayload } from './incoming-share'

// Stand-in for expo-sharing's native singleton: it holds the last share intent until cleared.
type NativeIntent = {
  raw: IncomingSharePayload[]
  resolve: () => Promise<IncomingSharePayload[]>
}
const native = vi.hoisted(() => {
  const state: { intent: NativeIntent | null } = { intent: null }
  return state
})
vi.mock('expo-sharing', () => ({
  getSharedPayloads: () => native.intent?.raw ?? [],
  getResolvedSharedPayloadsAsync: () => native.intent?.resolve() ?? Promise.resolve([]),
  clearSharedPayloads: () => {
    native.intent = null
  }
}))
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))

const { normalizeIncomingShare, offerIncomingShare, takeIncomingShare } =
  await import('./incoming-share')
const { receiveIncomingShare } = await import('./incoming-share-intake')
const { redirectSystemPath } = await import('../../app/+native-intent')

const chromeUrl: IncomingSharePayload = {
  value: 'https://arxiv.org/abs/2401.01234?v=2#sec',
  shareType: 'url',
  mimeType: 'text/plain'
}
const galleryPhoto: IncomingSharePayload = {
  value: 'content://media/external/images/media/42',
  shareType: 'image',
  mimeType: 'image/jpeg'
}
const galleryPhotoCopy: IncomingSharePayload = {
  ...galleryPhoto,
  contentUri: 'file:/data/user/0/com.stably.orca.mobile/cache/PXL_0042.jpg',
  contentSize: 2048,
  contentMimeType: 'image/jpeg',
  originalName: 'PXL_0042.jpg'
}

afterEach(() => {
  native.intent = null
  takeIncomingShare()
})

describe('normalizeIncomingShare', () => {
  it('keeps shared URLs and text verbatim', () => {
    expect(
      normalizeIncomingShare([
        chromeUrl,
        { value: '  This result looks relevant to MyoGen\n', shareType: 'text' }
      ])
    ).toEqual({
      text: 'https://arxiv.org/abs/2401.01234?v=2#sec\n  This result looks relevant to MyoGen\n',
      files: []
    })
  })

  it('turns resolved streams into readable cache files', () => {
    expect(normalizeIncomingShare([galleryPhotoCopy])).toEqual({
      text: '',
      files: [
        {
          uri: 'file:///data/user/0/com.stably.orca.mobile/cache/PXL_0042.jpg',
          mimeType: 'image/jpeg',
          name: 'PXL_0042.jpg',
          size: 2048
        }
      ]
    })
  })

  // expo-sharing labels a text/* file stream shareType 'text', with its URI as the value.
  it('treats a shared Markdown file as a file, not as text', () => {
    const share = normalizeIncomingShare([
      {
        value: 'content://com.android.providers.downloads.documents/document/notes.md',
        shareType: 'text',
        mimeType: 'text/markdown'
      }
    ])
    expect(share?.text).toBe('')
    expect(share?.files.map((file) => [file.name, file.mimeType])).toEqual([
      ['notes.md', 'text/markdown']
    ])
  })

  it('has nothing to offer for blank text', () => {
    expect(normalizeIncomingShare([{ value: '  ', shareType: 'text' }])).toBeNull()
    expect(normalizeIncomingShare([])).toBeNull()
  })
})

describe('incoming share intake', () => {
  it('reads one share once, even when several triggers ask for it', async () => {
    // Resolving a URL fetches it and throws offline; a URL share must never need it.
    native.intent = {
      raw: [chromeUrl],
      resolve: () => Promise.reject(new Error('Failed to resolve shared data'))
    }

    expect(await Promise.all([receiveIncomingShare(), receiveIncomingShare()])).toEqual([
      true,
      false
    ])
    expect(await receiveIncomingShare()).toBe(false)
    expect(takeIncomingShare()).toEqual({ text: chromeUrl.value, files: [] })
    expect(takeIncomingShare()).toBeNull()
  })

  it('keeps the app-cache copy of a shared file, not the sender URI', async () => {
    native.intent = { raw: [galleryPhoto], resolve: async () => [galleryPhotoCopy] }

    expect(await receiveIncomingShare()).toBe(true)
    expect(takeIncomingShare()?.files.map((file) => file.uri)).toEqual([
      'file:///data/user/0/com.stably.orca.mobile/cache/PXL_0042.jpg'
    ])
    expect(native.intent).toBeNull()
  })

  it('reads a newer share that arrives while an earlier one is being copied, not clear it', async () => {
    native.intent = {
      raw: [galleryPhoto],
      resolve: async () => {
        native.intent = {
          raw: [chromeUrl],
          resolve: () => Promise.reject(new Error('Failed to resolve shared data'))
        }
        return [galleryPhotoCopy]
      }
    }

    expect(await receiveIncomingShare()).toBe(true)
    expect(takeIncomingShare()).toEqual({ text: chromeUrl.value, files: [] })
    expect(native.intent).toBeNull()
  })

  it('lets a newer share replace one nobody claimed', () => {
    offerIncomingShare({ text: 'first', files: [] })
    offerIncomingShare({ text: 'second', files: [] })
    expect(takeIncomingShare()?.text).toBe('second')
  })
})

describe('redirectSystemPath', () => {
  it('keeps the share marker link off the router and passes other links through', () => {
    expect(redirectSystemPath({ path: 'orca://expo-sharing', initial: true })).toBeNull()
    expect(redirectSystemPath({ path: 'orca://pair?code=abc', initial: false })).toBe(
      'orca://pair?code=abc'
    )
  })
})
