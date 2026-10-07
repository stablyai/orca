import { posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { NestedRepoScanResult } from '../../shared/project-group-types'
import { scanNestedRepos } from './nested-repo-discovery'

function fixture(paths = posix) {
  const root = paths.resolve('/workspace')
  const reads: string[] = []
  const probes: string[] = []
  return {
    root,
    reads,
    probes,
    filesystem: {
      readDirectory: async (directory: string) => {
        reads.push(directory)
        if (directory !== root) {
          throw Object.assign(new Error('read failed'), { code: 'EACCES' })
        }
        return [
          { name: '.gitignore', isDirectory: false },
          { name: 'ignored', isDirectory: true },
          { name: 'node_modules', isDirectory: true },
          { name: 'linked', isDirectory: true, isSymlink: true },
          { name: 'unreadable', isDirectory: true },
          { name: 'visible', isDirectory: true }
        ]
      },
      readTextFile: async () => '# container rules\n/ignored/\n!visible/\n',
      joinPath: paths.join,
      basename: paths.basename,
      hasGitMarker: (directory: string) => {
        probes.push(directory)
        return paths.basename(directory) === 'visible'
      },
      isSelectedPathGitRepo: () => false
    }
  }
}

describe('nested repository scan diagnostics', () => {
  it.each([posix, win32])('reports host paths without probing excluded folders', async (paths) => {
    const f = fixture(paths)
    const snapshots: NestedRepoScanResult[] = []
    const scan = await scanNestedRepos({
      path: f.root,
      filesystem: f.filesystem,
      onProgress: (snapshot) => snapshots.push(snapshot)
    })
    expect(scan.repos.map(({ path }) => path)).toEqual([paths.join(f.root, 'visible')])
    expect(f.probes).toEqual([paths.join(f.root, 'unreadable'), paths.join(f.root, 'visible')])
    expect(f.reads).toEqual([f.root, paths.join(f.root, 'unreadable')])
    expect(scan.diagnostics?.counts).toEqual({
      symlink: 1,
      gitignore: 1,
      builtin: 1,
      unreadable: 1
    })
    expect(scan.diagnostics?.details).toContainEqual({
      path: paths.join(f.root, 'ignored'),
      reason: 'gitignore',
      ignoreFile: paths.join(f.root, '.gitignore'),
      rule: '/ignored/',
      line: 2
    })
    expect(scan.diagnostics?.details).toContainEqual({
      path: paths.join(f.root, 'unreadable'),
      reason: 'unreadable',
      errorCode: 'EACCES'
    })
    expect(snapshots[0].diagnostics?.counts.unreadable).toBeUndefined()
    expect(snapshots[0].diagnostics?.details).toHaveLength(3)
  })

  it('explains a zero-result scan without descending into ignored repositories', async () => {
    const f = fixture()
    const scan = await scanNestedRepos({
      path: f.root,
      filesystem: {
        ...f.filesystem,
        readDirectory: async () => [
          { name: '.gitignore', isDirectory: false },
          { name: 'ignored', isDirectory: true }
        ]
      }
    })
    expect(scan.repos).toEqual([])
    expect(f.probes).toEqual([])
    expect(scan.diagnostics?.counts).toEqual({ gitignore: 1 })
  })

  it('reports depth non-traversal without reinterpreting truncated', async () => {
    const read = vi.fn(async () => [{ name: 'deeper', isDirectory: true }])
    const scan = await scanNestedRepos({
      path: '/workspace',
      options: { maxDepth: 1 },
      filesystem: { ...fixture().filesystem, readDirectory: read, hasGitMarker: () => false }
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(scan.diagnostics?.details).toEqual([
      { path: '/workspace/deeper/deeper', reason: 'depth-limit' }
    ])
    expect(scan.truncated).toBe(false)
  })

  it('bounds details while counting only observed exclusions', async () => {
    const scan = await scanNestedRepos({
      path: '/workspace',
      filesystem: {
        ...fixture().filesystem,
        readDirectory: async () => [
          { name: '.gitignore', isDirectory: false },
          ...Array.from({ length: 130 }, (_, i) => ({ name: `ignored-${i}`, isDirectory: true }))
        ],
        readTextFile: async () => 'ignored-*'
      }
    })
    expect(scan.diagnostics).toMatchObject({ counts: { gitignore: 130 }, omittedDetails: 30 })
    expect(scan.diagnostics?.details).toHaveLength(100)
  })

  it('marks shortened literal evidence and does not infer a permission failure', async () => {
    const root = `/workspace/${'x'.repeat(2200)}`
    const scan = await scanNestedRepos({
      path: root,
      filesystem: {
        ...fixture().filesystem,
        readDirectory: async () => {
          throw new Error('unknown failure')
        }
      }
    })
    expect(scan.diagnostics?.details[0]).toMatchObject({ reason: 'unreadable', shortened: true })
    expect(scan.diagnostics?.details[0].path.length).toBe(2049)
    expect(scan.diagnostics?.details[0].errorCode).toBeUndefined()
  })

  it('returns Git-root classification without scanning children', async () => {
    const read = vi.fn(async () => [])
    const scan = await scanNestedRepos({
      path: '/workspace',
      filesystem: {
        ...fixture().filesystem,
        isSelectedPathGitRepo: () => true,
        readDirectory: read
      }
    })
    expect(scan.selectedPathKind).toBe('git_repo')
    expect(read).not.toHaveBeenCalled()
    expect(scan.diagnostics?.details).toEqual([])
  })
})
