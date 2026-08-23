import { describe, expect, it } from 'vitest'
import {
  buildOriginHeadFetchArgs,
  buildOriginHeadUpdateRefArgs,
  buildRepoInitArgs,
  buildRepoProjectSeedCloneArgs,
  buildRepoSyncArgs,
  buildSeedGitDirConfigArgs,
  getRepoManagedProjectsGitDir,
  parseGitDirPointer,
  parseRepoProjectList,
  readRepoManagedCheckoutIdentity,
  resolveRepoManagedManifestFile,
  resolveRepoManagedSourceGitDir
} from './repo-managed-checkout'

const posixJoin = (...parts: string[]) => parts.join('/')

describe('repo-managed checkout identity', () => {
  it('reads manifest identity from the opened tree and prefers local objects', async () => {
    const identity = await readRepoManagedCheckoutIdentity({
      mainPath: '/src/aosp',
      git: {
        configGet: async (_gitDir, key) => {
          if (key === 'remote.origin.url') {
            return 'sso://android/platform/manifest\n'
          }
          if (key === 'manifest.groups') {
            return 'default,vendor\n'
          }
          return null
        },
        abbrevRef: async () => 'android-15.0.0_r1'
      },
      paths: {
        join: posixJoin,
        basename: (path) => path.split('/').at(-1) ?? path,
        realpath: async () => '/src/aosp/.repo/manifests/default.xml',
        exists: async (path) => path === '/src/aosp/.repo/repo/repo'
      }
    })

    expect(identity).toEqual({
      manifestUrl: 'sso://android/platform/manifest',
      manifestBranch: 'android-15.0.0_r1',
      manifestFile: 'default.xml',
      groups: 'default,vendor',
      repoUrl: '/src/aosp/.repo/repo'
    })
    expect(buildRepoInitArgs({ identity, referencePath: '/src/aosp' })).toEqual([
      'init',
      '-u',
      'sso://android/platform/manifest',
      '-m',
      'default.xml',
      '-b',
      'android-15.0.0_r1',
      '--reference',
      '/src/aosp',
      '--groups',
      'default,vendor',
      '--repo-url',
      '/src/aosp/.repo/repo'
    ])
    expect(buildRepoSyncArgs()).toEqual([
      'sync',
      '--local-only',
      '--no-manifest-update',
      '--fail-fast'
    ])
  })

  it('parses project.list and gitdir pointers', () => {
    expect(parseRepoProjectList('# comment\nbionic\n\nframeworks/base\n')).toEqual([
      'bionic',
      'frameworks/base'
    ])
    expect(parseGitDirPointer('gitdir: ../.repo/projects/bionic.git\n', '/src/aosp/bionic')).toBe(
      '/src/aosp/.repo/projects/bionic.git'
    )
    expect(getRepoManagedProjectsGitDir('/src/aosp', 'packages/apps/Settings')).toBe(
      '/src/aosp/.repo/projects/packages/apps/Settings.git'
    )
  })

  it('falls back to the local manifests gitdir when origin is missing', async () => {
    const identity = await readRepoManagedCheckoutIdentity({
      mainPath: '/src/aosp',
      git: {
        configGet: async () => null,
        abbrevRef: async () => 'HEAD'
      },
      paths: {
        join: posixJoin,
        basename: (path) => path.split('/').at(-1) ?? path,
        exists: async () => false
      }
    })

    expect(identity.manifestUrl).toBe('/src/aosp/.repo/manifests.git')
    expect(identity.manifestBranch).toBeNull()
    expect(identity.repoUrl).toBeNull()
    expect(buildRepoInitArgs({ identity, referencePath: '/src/aosp' })).toEqual([
      'init',
      '-u',
      '/src/aosp/.repo/manifests.git',
      '-m',
      'default.xml',
      '--reference',
      '/src/aosp'
    ])
  })

  it('never uses a gitfile as the clone source when the object farm exists', async () => {
    const directories = new Set(['/src/aosp/.repo/projects/frameworks/base.git'])
    const files = new Map([
      ['/src/aosp/frameworks/base/.git', 'gitdir: ../../.repo/projects/frameworks/base.git\n']
    ])
    const source = await resolveRepoManagedSourceGitDir({
      mainPath: '/src/aosp',
      relPath: 'frameworks/base',
      paths: {
        join: posixJoin,
        isDirectory: (path) => directories.has(path),
        isFile: (path) => files.has(path),
        readTextFile: async (path) => {
          const content = files.get(path)
          if (content === undefined) {
            throw new Error('missing')
          }
          return content
        }
      }
    })
    expect(source).toBe('/src/aosp/.repo/projects/frameworks/base.git')
    expect(source).not.toBe('/src/aosp/frameworks/base/.git')
  })

  it('follows a gitfile pointer when the object farm path is missing', async () => {
    const directories = new Set(['/alt/objects/bionic.git'])
    const files = new Map([['/src/aosp/bionic/.git', 'gitdir: /alt/objects/bionic.git\n']])
    await expect(
      resolveRepoManagedSourceGitDir({
        mainPath: '/src/aosp',
        relPath: 'bionic',
        paths: {
          join: posixJoin,
          isDirectory: (path) => directories.has(path),
          isFile: (path) => files.has(path),
          readTextFile: async (path) => {
            const content = files.get(path)
            if (content === undefined) {
              throw new Error('missing')
            }
            return content
          }
        }
      })
    ).resolves.toBe('/alt/objects/bionic.git')
  })

  it('falls back to a worktree git directory when there is no object farm', async () => {
    const directories = new Set(['/src/aosp/bionic/.git'])
    await expect(
      resolveRepoManagedSourceGitDir({
        mainPath: '/src/aosp',
        relPath: 'bionic',
        paths: {
          join: posixJoin,
          isDirectory: (path) => directories.has(path),
          isFile: () => false,
          readTextFile: async () => {
            throw new Error('missing')
          }
        }
      })
    ).resolves.toBe('/src/aosp/bionic/.git')
  })

  it('returns null when a gitfile points at a missing git directory', async () => {
    await expect(
      resolveRepoManagedSourceGitDir({
        mainPath: '/src/aosp',
        relPath: 'bionic',
        paths: {
          join: posixJoin,
          isDirectory: () => false,
          isFile: (path) => path === '/src/aosp/bionic/.git',
          readTextFile: async () => 'gitdir: ../.repo/projects/bionic.git\n'
        }
      })
    ).resolves.toBeNull()
  })

  it('clones by reference from the resolved git dir instead of --shared', () => {
    expect(
      buildRepoProjectSeedCloneArgs(
        '/src/aosp/.repo/projects/bionic.git',
        '/tmp/task/.repo/projects/bionic.git'
      )
    ).toEqual([
      'clone',
      '--bare',
      '--reference',
      '/src/aosp/.repo/projects/bionic.git',
      '/src/aosp/.repo/projects/bionic.git',
      '/tmp/task/.repo/projects/bionic.git'
    ])
    expect(
      buildOriginHeadFetchArgs(
        '/tmp/task/.repo/projects/bionic.git',
        '/src/aosp/.repo/projects/bionic.git'
      )
    ).toEqual([
      '--git-dir',
      '/tmp/task/.repo/projects/bionic.git',
      'fetch',
      '--no-tags',
      '/src/aosp/.repo/projects/bionic.git',
      '+refs/heads/*:refs/remotes/origin/*'
    ])
    expect(buildOriginHeadUpdateRefArgs('/tmp/task/.repo/projects/bionic.git', 'main')).toEqual([
      '--git-dir',
      '/tmp/task/.repo/projects/bionic.git',
      'update-ref',
      'refs/remotes/origin/main',
      'refs/heads/main'
    ])
    expect(
      buildRepoProjectSeedCloneArgs(
        '/src/aosp/.repo/projects/bionic.git',
        '/tmp/task/.repo/projects/bionic.git'
      )
    ).not.toContain('--shared')
    expect(
      buildSeedGitDirConfigArgs(
        '/tmp/task/.repo/projects/bionic.git',
        '/src/aosp/.repo/projects/bionic.git'
      )
    ).toEqual([
      ['--git-dir', '/tmp/task/.repo/projects/bionic.git', 'config', 'core.bare', 'false'],
      [
        '--git-dir',
        '/tmp/task/.repo/projects/bionic.git',
        'config',
        'remote.origin.url',
        '/src/aosp/.repo/projects/bionic.git'
      ],
      [
        '--git-dir',
        '/tmp/task/.repo/projects/bionic.git',
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*'
      ]
    ])
  })

  it('maps a copied .repo/manifest.xml file to default.xml so repo init can find it', async () => {
    expect(resolveRepoManagedManifestFile('manifest.xml')).toBe('default.xml')
    expect(resolveRepoManagedManifestFile('default.xml')).toBe('default.xml')
    expect(resolveRepoManagedManifestFile('android-latest.xml')).toBe('android-latest.xml')
    expect(resolveRepoManagedManifestFile('')).toBe('default.xml')
    expect(resolveRepoManagedManifestFile(null)).toBe('default.xml')

    const identity = await readRepoManagedCheckoutIdentity({
      mainPath: '/src/aosp',
      git: {
        configGet: async () => null,
        abbrevRef: async () => 'HEAD'
      },
      paths: {
        join: posixJoin,
        basename: (path) => path.split('/').at(-1) ?? path,
        realpath: async (path) => path,
        exists: async () => false
      }
    })
    expect(identity.manifestFile).toBe('default.xml')
    expect(buildRepoInitArgs({ identity, referencePath: '/src/aosp' })).toEqual([
      'init',
      '-u',
      '/src/aosp/.repo/manifests.git',
      '-m',
      'default.xml',
      '--reference',
      '/src/aosp'
    ])
  })

  it('keeps a custom manifest filename when .repo/manifest.xml points into manifests/', async () => {
    const identity = await readRepoManagedCheckoutIdentity({
      mainPath: '/src/aosp',
      git: {
        configGet: async () => 'https://example.com/manifest.git\n',
        abbrevRef: async () => 'main'
      },
      paths: {
        join: posixJoin,
        basename: (path) => path.split('/').at(-1) ?? path,
        realpath: async () => '/src/aosp/.repo/manifests/android-latest.xml',
        exists: async () => false
      }
    })
    expect(identity.manifestFile).toBe('android-latest.xml')
    expect(buildRepoInitArgs({ identity, referencePath: '/src/aosp' })[4]).toBe(
      'android-latest.xml'
    )
  })

  it('falls back to default.xml when realpath of manifest.xml fails', async () => {
    const identity = await readRepoManagedCheckoutIdentity({
      mainPath: '/src/aosp',
      git: {
        configGet: async () => null,
        abbrevRef: async () => 'HEAD'
      },
      paths: {
        join: posixJoin,
        basename: (path) => path.split('/').at(-1) ?? path,
        realpath: async () => {
          throw new Error('ENOENT')
        },
        exists: async () => false
      }
    })
    expect(identity.manifestFile).toBe('default.xml')
  })

  it('parses gitdir pointers and ignores empty or malformed files', () => {
    expect(parseGitDirPointer('', '/src/aosp/bionic')).toBeNull()
    expect(parseGitDirPointer('not a gitfile\n', '/src/aosp/bionic')).toBeNull()
    expect(parseGitDirPointer('gitdir:\n', '/src/aosp/bionic')).toBeNull()
    expect(parseGitDirPointer('gitdir: /abs/bionic.git\n', '/src/aosp/bionic')).toBe(
      '/abs/bionic.git'
    )
    expect(parseGitDirPointer('gitdir: C:\\farm\\bionic.git\n', 'C:\\src\\aosp\\bionic')).toBe(
      'C:\\farm\\bionic.git'
    )
    expect(
      parseRepoProjectList('  # skip\r\n\r\nbionic\r\n# also skip\r\nframeworks/base  \r\n')
    ).toEqual(['bionic', 'frameworks/base'])
  })

  it('never returns a gitfile path even when that is the only .git entry', async () => {
    const directories = new Set(['/src/aosp/.repo/projects/bionic.git'])
    const files = new Set(['/src/aosp/bionic/.git'])
    const source = await resolveRepoManagedSourceGitDir({
      mainPath: '/src/aosp',
      relPath: 'bionic',
      paths: {
        join: posixJoin,
        isDirectory: (path) => directories.has(path),
        isFile: (path) => files.has(path),
        readTextFile: async () => 'gitdir: ../.repo/projects/bionic.git\n'
      }
    })
    expect(source).toBe('/src/aosp/.repo/projects/bionic.git')
    expect(source?.endsWith('/.git')).toBe(false)
  })
})
