import { describe, expect, it } from 'vitest'
import {
  nativeDependencyClosure,
  nativeWorkspaceSettings
} from './native-dependency-lock-digest.mjs'

const lockfile = ({
  pty = 'node-pty@1.1.0(patch_hash=aa)',
  addon = '7.1.1',
  electron = '43.8.1'
}) => `---
lockfileVersion: '9.0'
importers:
  .:
    packageManagerDependencies:
      pnpm: {specifier: 12.14.0, version: 12.14.0}
---
lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      electron: {specifier: ${electron}, version: ${electron}(supports-color@7.2.0)}
  native/addon:
    dependencies:
      node-addon-api: {specifier: ^8.5.0, version: 8.9.2}
snapshots:
  ${pty}:
    dependencies:
      node-addon-api: ${addon}
  node-addon-api@7.1.0: {}
  node-addon-api@7.1.1: {}
  node-addon-api@8.9.2: {}
  electron@${electron}(supports-color@7.2.0):
    dependencies:
      got: 11.8.6
  got@11.8.6: {}
  zustand@5.0.15: {}
`
const selection = {
  packages: ['node-pty'],
  versionOnly: ['electron'],
  workspaces: ['native/addon']
}

describe('native dependency lock closure', () => {
  it('pins native closures, workspace addons and the Electron release only', () => {
    expect(nativeDependencyClosure(lockfile({}), selection)).toEqual([
      'electron@43.8.1',
      'node-addon-api@7.1.1',
      'node-addon-api@8.9.2',
      'node-pty@1.1.0(patch_hash=aa)'
    ])
    for (const change of [
      { pty: 'node-pty@1.1.0(patch_hash=bb)' },
      { addon: '7.1.0' },
      { electron: '43.9.0' }
    ]) {
      expect(nativeDependencyClosure(lockfile(change), selection)).not.toEqual(
        nativeDependencyClosure(lockfile({}), selection)
      )
    }
  })

  it('fails closed when a selected package or dependency is not locked', () => {
    expect(() => nativeDependencyClosure(lockfile({}), { packages: ['missing'] })).toThrow(
      /locks none of missing/
    )
    expect(() =>
      nativeDependencyClosure(lockfile({}), { ...selection, packages: ['node-pty', 'node-gyp'] })
    ).toThrow(/locks none of node-gyp$/)
    expect(() =>
      nativeDependencyClosure(lockfile({}), { ...selection, versionOnly: ['electron', 'nw'] })
    ).toThrow(/locks none of nw$/)
    expect(() =>
      nativeDependencyClosure(lockfile({ addon: '9.9.9' }), { packages: ['node-pty'] })
    ).toThrow(/no snapshot for node-addon-api@9.9.9/)
  })

  it('keeps layout settings and native build approvals but drops resolution-only settings', () => {
    const settings = `
shamefullyHoist: true
minimumReleaseAge: 4320
overrides: {a: 1}
patchedDependencies: {x: y}
allowBuilds: {node-pty: true, bun: true}
`
    expect(nativeWorkspaceSettings(settings, ['node-pty@1.1.0(patch_hash=aa)'])).toEqual({
      allowBuilds: { 'node-pty': true },
      shamefullyHoist: true
    })
  })
})
