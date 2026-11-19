import { expect, it } from 'vitest'
import { readClipboardCopiedFilePaths } from './clipboard-copied-file-paths'

function clipboardWith(contents: Record<string, string>): {
  readBuffer: (format: string) => Buffer
} {
  return {
    readBuffer: (format) => Buffer.from(contents[format] ?? '')
  }
}

it('reads GNOME copied-file lists so Orca can paste copied files into the explorer', () => {
  const clipboard = clipboardWith({
    'x-special/gnome-copied-files': 'copy\nfile:///home/user/assets/photo%20copy.png'
  })

  expect(readClipboardCopiedFilePaths(clipboard, 'linux')).toEqual([
    '/home/user/assets/photo copy.png'
  ])
})

it('does not treat GNOME cut-file lists as copy operations', () => {
  const clipboard = clipboardWith({
    'x-special/gnome-copied-files': 'cut\nfile:///home/user/assets/photo.png',
    'text/uri-list': 'file:///home/user/assets/photo.png\r\n'
  })

  expect(readClipboardCopiedFilePaths(clipboard, 'linux')).toEqual([])
})
