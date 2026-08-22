import { describe, expect, it } from 'vitest'
import {
  buildRepoInitArgs,
  buildRepoSyncArgs,
  readRepoManagedCheckoutIdentity
} from './repo-managed-checkout'

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
        join: (parent, child) => `${parent}/${child}`,
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
    expect(buildRepoSyncArgs()).toEqual(['sync', '--local-only', '--current-branch', '--fail-fast'])
  })

  it('falls back to the local manifests gitdir when origin is missing', async () => {
    const identity = await readRepoManagedCheckoutIdentity({
      mainPath: '/src/aosp',
      git: {
        configGet: async () => null,
        abbrevRef: async () => 'HEAD'
      },
      paths: {
        join: (parent, child) => `${parent}/${child}`,
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
})
