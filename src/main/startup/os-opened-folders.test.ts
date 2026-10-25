import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  folderPathsFromArguments,
  folderArgumentsFromLaunch,
  OsOpenedFolderState,
  resolveOsOpenedFolders
} from './os-opened-folders'

describe('OS-opened folders', () => {
  it.each([true, false])(
    'skips launch entries for first and second launches (packaged=%s)',
    (packaged) => {
      const entries = packaged ? ['C:\\Orca.exe'] : ['C:\\electron.exe', 'C:\\app']
      for (const argv of [[...entries], [...entries, 'C:\\My Projects']]) {
        expect(folderArgumentsFromLaunch(argv, packaged)).toEqual(argv.slice(entries.length))
      }
    }
  )

  it('deduplicates state paths case-insensitively only on Windows', () => {
    const state = new OsOpenedFolderState()
    expect(state.capture([])).toBe(false)
    const first = path.resolve('Folder')
    const second = path.resolve('folder')
    state.capture([first, second])
    expect(state.consume()).toEqual(process.platform === 'win32' ? [first] : [first, second])
  })

  it('restores undelivered paths ahead of newer paths', () => {
    const state = new OsOpenedFolderState()
    const first = path.resolve('first')
    const next = path.resolve('next')
    state.capture([first])
    const batch = state.consume()
    state.capture([next])
    state.restore(batch)
    expect(state.consume()).toEqual([first, next])
  })
  it('parses absolute paths, URLs and UNC paths with Windows deduplication', () => {
    expect(
      folderPathsFromArguments(
        [
          'C:\\My Projects\\repo',
          'c:\\my projects\\REPO',
          '\\\\server\\share\\dir',
          'file:///C:/x',
          'file:///C:/Other%20Folder',
          'file://server/share',
          '--flag',
          'relative',
          'file:///%zz'
        ],
        'win32'
      )
    ).toEqual([
      'C:\\My Projects\\repo',
      '\\\\server\\share\\dir',
      'C:\\x',
      'C:\\Other Folder',
      '\\\\server\\share\\'
    ])
    expect(folderPathsFromArguments(['/home/me', '/HOME/me', 'relative'], 'linux')).toEqual([
      '/home/me',
      '/HOME/me'
    ])
  })

  it('keeps the folder name when the shell appends a trailing \\. to the background path', () => {
    expect(
      folderPathsFromArguments(
        ['C:\\repo\\.', 'C:\\\\.', 'd:\\\\.', '\\\\srv\\share\\dir\\.'],
        'win32'
      )
    ).toEqual(['C:\\repo', 'C:\\', 'd:\\', '\\\\srv\\share\\dir'])
    expect(folderPathsFromArguments(['C:"'], 'win32')).toEqual([])
  })

  it('caps buffered paths and restores undelivered paths first', () => {
    const state = new OsOpenedFolderState()
    const paths = Array.from({ length: 40 }, (_, i) => path.resolve(`folder-${i}`))
    expect(state.capture(paths)).toBe(true)
    const batch = state.consume()
    expect(batch).toEqual(paths.slice(0, 32))
    expect(state.consume()).toEqual([])
    state.capture([paths[35]!])
    state.restore(batch)
    expect(state.consume()).toEqual(batch)
    expect(state.capture(['--flag', 'relative'])).toBe(false)
  })

  it('resolves directories including x.md, dropping files and missing paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-folders-'))
    try {
      const directory = path.join(root, 'notes.md')
      const file = path.join(root, 'file.md')
      await mkdir(directory)
      await writeFile(file, 'content')
      expect(await resolveOsOpenedFolders([directory, file, path.join(root, 'missing')])).toEqual([
        directory
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
