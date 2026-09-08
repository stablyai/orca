import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../src/shared/clipboard-image'
import { MOBILE_WEB_NATIVE_CHAT_IMAGE_PREVIEW_MAX_CHARACTERS } from '../../../src/shared/mobile-web/native-chat-operation-contract'
import { createMobileNativeChatImagePreview } from './mobile-native-chat-image-thumbnail'

const fileState = vi.hoisted(() => ({
  instances: [] as {
    uri: string
    create: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }[]
}))

const imageState = vi.hoisted(() => ({
  sources: [] as string[],
  widths: [] as number[],
  results: [] as (string | null)[],
  contexts: [] as {
    release: ReturnType<typeof vi.fn>
  }[],
  rendered: [] as {
    release: ReturnType<typeof vi.fn>
    saveAsync: ReturnType<typeof vi.fn>
  }[]
}))

vi.mock('expo-file-system', () => {
  class MockFile {
    readonly uri: string
    readonly create = vi.fn()
    readonly write = vi.fn()
    readonly delete = vi.fn()

    constructor(...parts: string[]) {
      this.uri = parts.length === 1 ? parts[0]! : `${parts[0]}/${parts[1]}`
      fileState.instances.push(this)
    }
  }

  return { File: MockFile, Paths: { cache: 'file:///cache' } }
})

vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: {
    manipulate(source: string) {
      imageState.sources.push(source)
      let width = 0
      const context = {
        resize: vi.fn((size: { width: number }) => {
          width = size.width
          imageState.widths.push(width)
        }),
        renderAsync: vi.fn(async () => {
          const rendered = {
            release: vi.fn(),
            saveAsync: vi.fn(async () => ({
              base64: imageState.results.shift() ?? null,
              uri: `file:///rendered-${width}.jpg`
            }))
          }
          imageState.rendered.push(rendered)
          return rendered
        }),
        release: vi.fn()
      }
      imageState.contexts.push(context)
      return context
    }
  },
  SaveFormat: { JPEG: 'jpeg' }
}))

beforeEach(() => {
  fileState.instances.length = 0
  imageState.sources.length = 0
  imageState.widths.length = 0
  imageState.results.length = 0
  imageState.contexts.length = 0
  imageState.rendered.length = 0
})

describe('mobile native-chat image thumbnail', () => {
  it('renders a bounded JPEG preview from the picked file URI', async () => {
    imageState.results.push('preview')

    await expect(
      createMobileNativeChatImagePreview({ base64: 'original', uri: 'file:///picked.png' })
    ).resolves.toBe('data:image/jpeg;base64,preview')
    expect(imageState.sources).toEqual(['file:///picked.png'])
    expect(imageState.widths).toEqual([192])
    expect(imageState.rendered[0]!.saveAsync).toHaveBeenCalledWith({
      base64: true,
      compress: 0.65,
      format: 'jpeg'
    })
    expect(imageState.contexts[0]!.release).toHaveBeenCalledOnce()
    expect(imageState.rendered[0]!.release).toHaveBeenCalledOnce()
    expect(fileState.instances[0]!.uri).toBe('file:///rendered-192.jpg')
    expect(fileState.instances[0]!.delete).toHaveBeenCalledOnce()
  })

  it('retries at smaller dimensions when the first preview exceeds the bridge bound', async () => {
    imageState.results.push(
      'x'.repeat(MOBILE_WEB_NATIVE_CHAT_IMAGE_PREVIEW_MAX_CHARACTERS),
      'smaller'
    )

    await expect(
      createMobileNativeChatImagePreview({ base64: 'original', uri: 'file:///picked.png' })
    ).resolves.toBe('data:image/jpeg;base64,smaller')
    expect(imageState.widths).toEqual([192, 96])
    expect(fileState.instances.map((file) => file.uri)).toEqual([
      'file:///rendered-192.jpg',
      'file:///rendered-96.jpg'
    ])
    expect(fileState.instances.every((file) => file.delete.mock.calls.length === 1)).toBe(true)
  })

  it('creates and always removes a cache input when the picker has no URI', async () => {
    imageState.results.push('preview')

    await createMobileNativeChatImagePreview({ base64: 'original' })

    const input = fileState.instances.find((file) => file.uri.includes('orca-native-chat-preview-'))
    expect(input).toBeDefined()
    expect(input!.create).toHaveBeenCalledWith({ overwrite: false })
    expect(input!.write).toHaveBeenCalledWith('original', { encoding: 'base64' })
    expect(input!.delete).toHaveBeenCalledOnce()
  })

  it('cleans every render and rejects when no bounded preview can be produced', async () => {
    imageState.results.push(null, null, null)

    await expect(
      createMobileNativeChatImagePreview({ base64: 'original', uri: 'file:///picked.png' })
    ).rejects.toThrow(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
    expect(imageState.widths).toEqual([192, 96, 48])
    expect(imageState.contexts.every((context) => context.release.mock.calls.length === 1)).toBe(
      true
    )
    expect(imageState.rendered.every((rendered) => rendered.release.mock.calls.length === 1)).toBe(
      true
    )
    expect(fileState.instances.every((file) => file.delete.mock.calls.length === 1)).toBe(true)
  })
})
