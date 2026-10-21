import { describe, expect, it } from 'vitest'
import { MobileFileTooLargeError, type PickedMobileFile } from '../platform/media-picker-contract'
import {
  nativeChatTextWithFileReferences,
  uploadPickedNativeChatFiles,
  type PendingNativeChatFile
} from './mobile-native-chat-file-attachment'

function picked(name: string): PickedMobileFile {
  return { name, mime: 'text/plain', byteLength: 1, base64: 'YQ==' }
}

async function* pickedFiles(files: PickedMobileFile[], thenThrow?: Error) {
  for (const file of files) {
    yield file
  }
  if (thenThrow) {
    throw thenThrow
  }
}

describe('nativeChatTextWithFileReferences', () => {
  it('references each stored file on a line after the text', () => {
    expect(
      nativeChatTextWithFileReferences('Review these  ', [
        { path: '/store/1/spec.pdf' },
        { path: '/store/2/my notes.md' }
      ])
    ).toBe('Review these\n@/store/1/spec.pdf @"/store/2/my notes.md"')
  })

  it('sends the references alone when there is no text, and the text alone with no files', () => {
    expect(nativeChatTextWithFileReferences('  ', [{ path: '/store/1/spec.pdf' }])).toBe(
      '@/store/1/spec.pdf'
    )
    expect(nativeChatTextWithFileReferences('hi', [])).toBe('hi')
  })
})

describe('uploadPickedNativeChatFiles', () => {
  function run(files: AsyncIterable<PickedMobileFile>, failName?: string) {
    const chips = new Map<string, PendingNativeChatFile>()
    const errors: string[] = []
    let id = 0
    const done = uploadPickedNativeChatFiles({
      picked: files,
      upload: async (file) => {
        if (file.name === failName) {
          throw new Error('host refused')
        }
        return { path: `/store/${file.name}`, name: file.name, byteLength: 1 }
      },
      nextId: () => `file-${(id += 1)}`,
      onPicked: (file) => chips.set(file.id, file),
      onStored: (fileId, stored) => {
        const chip = chips.get(fileId)
        if (chip) {
          chips.set(fileId, { ...chip, path: stored.path })
        }
      },
      onFailed: (fileId) => chips.delete(fileId),
      onError: (message) => errors.push(message)
    })
    return { chips, errors, done }
  }

  it('keeps every stored file as a chip with its host path', async () => {
    const { chips, errors, done } = run(pickedFiles([picked('a.txt'), picked('b.txt')]))
    await done
    expect([...chips.values()].map((chip) => chip.path)).toEqual(['/store/a.txt', '/store/b.txt'])
    expect(errors).toEqual([])
  })

  it('drops the chip of a failed upload, says which file, and carries on', async () => {
    const { chips, errors, done } = run(pickedFiles([picked('a.txt'), picked('b.txt')]), 'a.txt')
    await done
    expect([...chips.values()].map((chip) => chip.name)).toEqual(['b.txt'])
    expect(errors).toEqual(["Couldn't upload a.txt"])
  })

  it('keeps what was stored before the picker refused an oversized file', async () => {
    const { chips, errors, done } = run(
      pickedFiles([picked('a.txt')], new MobileFileTooLargeError('clip.mov'))
    )
    await done
    expect([...chips.values()].map((chip) => chip.name)).toEqual(['a.txt'])
    expect(errors).toEqual([new MobileFileTooLargeError('clip.mov').message])
  })
})
