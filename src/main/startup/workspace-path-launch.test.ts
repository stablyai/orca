import { describe, expect, it, vi } from 'vitest'

vi.mock('node:os', () => ({ homedir: () => '/home/tester' }))

import {
  WorkspacePathLaunchQueue,
  extractWorkspacePathFromArgv,
  resolveExistingDirectoryPath
} from './workspace-path-launch'

/** Builds an injectable is-directory probe from the set of paths that exist as directories. */
function dirs(...paths: string[]): (path: string) => boolean {
  return new Set(paths).has.bind(new Set(paths))
}

describe('extractWorkspacePathFromArgv', () => {
  it('returns the first argument that is an existing directory', () => {
    const path = extractWorkspacePathFromArgv(
      ['orca', '--some-flag', '/repos/alpha'],
      { isPackaged: true },
      dirs('/repos/alpha')
    )
    expect(path).toBe('/repos/alpha')
  })

  it('skips flags, missing paths, and files before a directory', () => {
    const isDirectory = (path: string): boolean => path === '/repos/beta'
    const path = extractWorkspacePathFromArgv(
      ['orca', '--verbose', '/nope', '/repos/file.txt', 'beta', '/repos/beta'],
      { isPackaged: true },
      isDirectory
    )
    expect(path).toBe('/repos/beta')
  })

  it('expands a leading tilde to the home directory', () => {
    const path = extractWorkspacePathFromArgv(
      ['orca', '~/projects/demo'],
      { isPackaged: true },
      dirs('/home/tester/projects/demo')
    )
    expect(path).toBe('/home/tester/projects/demo')
  })

  it('resolves relative candidates against the given cwd', () => {
    const path = extractWorkspacePathFromArgv(
      ['orca', './sub/inner'],
      { isPackaged: true, cwd: '/work' },
      dirs('/work/sub/inner')
    )
    expect(path).toBe('/work/sub/inner')
  })

  it('rejects bare dot app indicators in dev launches', () => {
    const isDirectory = (): boolean => true
    expect(
      extractWorkspacePathFromArgv(['electron', '.'], { isPackaged: false }, isDirectory)
    ).toBeNull()
    expect(
      extractWorkspacePathFromArgv(['electron', '..'], { isPackaged: false }, isDirectory)
    ).toBeNull()
    expect(
      extractWorkspacePathFromArgv(['electron', '.'], { isPackaged: true }, isDirectory)
    ).not.toBeNull()
  })

  it('accepts windows drive-letter and UNC candidates regardless of host platform', () => {
    const isDirectory = dirs('C:\\repos\\alpha', '\\\\server\\share\\proj')
    expect(
      extractWorkspacePathFromArgv(
        ['orca.exe', 'C:\\repos\\alpha'],
        { isPackaged: true },
        isDirectory
      )
    ).toBe('C:\\repos\\alpha')
    expect(
      extractWorkspacePathFromArgv(
        ['orca.exe', '\\\\server\\share\\proj'],
        { isPackaged: true },
        isDirectory
      )
    ).toBe('\\\\server\\share\\proj')
  })

  it('ignores subcommand words that are not existing directories', () => {
    expect(extractWorkspacePathFromArgv(['orca', 'serve'], { isPackaged: true }, dirs())).toBeNull()
  })
})

describe('resolveExistingDirectoryPath', () => {
  it('normalizes dot segments in the candidate', () => {
    const path = resolveExistingDirectoryPath('/repos/alpha/../beta', {}, dirs('/repos/beta'))
    expect(path).toBe('/repos/beta')
  })

  it('rejects non-path words and missing directories', () => {
    expect(resolveExistingDirectoryPath('serve', {}, dirs())).toBeNull()
    expect(resolveExistingDirectoryPath('/missing/dir', {}, dirs())).toBeNull()
  })
})

describe('WorkspacePathLaunchQueue', () => {
  it('drains queued intents exactly once', () => {
    const queue = new WorkspacePathLaunchQueue()
    expect(queue.drain()).toEqual([])
    queue.queue('/repos/alpha')
    queue.queue('/repos/beta')
    expect(queue.drain()).toEqual(['/repos/alpha', '/repos/beta'])
    expect(queue.drain()).toEqual([])
  })
})
