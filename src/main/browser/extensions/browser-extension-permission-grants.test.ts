import { describe, expect, it } from 'vitest'
import {
  containsBrowserExtensionPermissions,
  effectiveBrowserExtensionPermissions,
  originPatternCovers,
  planBrowserExtensionPermissionRemoval,
  planBrowserExtensionPermissionRequest
} from './browser-extension-permission-grants'

// Bitwarden's shape: required APIs and hosts, optional nativeMessaging and privacy.
const manifest = {
  permissions: ['tabs', 'storage'],
  optional_permissions: ['nativeMessaging', 'privacy'],
  host_permissions: ['https://*/*'],
  optional_host_permissions: ['http://*.example.com/*']
}
const none = { grantedPermissions: [], grantedOrigins: [] }

describe('permission request planning', () => {
  it('prompts only for what is optional and not yet granted', () => {
    expect(
      planBrowserExtensionPermissionRequest(manifest, none, {
        permissions: ['privacy', 'tabs']
      })
    ).toEqual({ kind: 'prompt', add: { permissions: ['privacy'], origins: [] } })
    expect(
      planBrowserExtensionPermissionRequest(
        manifest,
        { grantedPermissions: ['privacy'], grantedOrigins: [] },
        { permissions: ['privacy'] }
      )
    ).toEqual({ kind: 'already-granted' })
  })

  it('refuses anything the manifest does not list', () => {
    const refused = {
      kind: 'invalid',
      error: 'Only permissions specified in the manifest may be requested.'
    }
    expect(
      planBrowserExtensionPermissionRequest(manifest, none, { permissions: ['history'] })
    ).toEqual(refused)
    expect(
      planBrowserExtensionPermissionRequest(manifest, none, { origins: ['http://other.test/*'] })
    ).toEqual(refused)
  })

  it('treats optional host patterns as covering narrower requests', () => {
    expect(
      planBrowserExtensionPermissionRequest(manifest, none, {
        origins: ['http://shop.example.com/cart/*', 'https://bank.test/*']
      })
    ).toEqual({
      kind: 'prompt',
      add: { permissions: [], origins: ['http://shop.example.com/cart/*'] }
    })
  })

  it('never removes required permissions and removes only what was granted', () => {
    expect(
      planBrowserExtensionPermissionRemoval(manifest, none, { permissions: ['tabs'] })
    ).toEqual({ kind: 'invalid', error: 'You cannot remove required permissions.' })
    expect(
      planBrowserExtensionPermissionRemoval(
        manifest,
        { grantedPermissions: ['privacy'], grantedOrigins: [] },
        { permissions: ['privacy', 'nativeMessaging'] }
      )
    ).toEqual({ kind: 'remove', removed: { permissions: ['privacy'], origins: [] } })
  })
})

describe('contains and getAll', () => {
  it('answers from required plus granted permissions', () => {
    const granted = { grantedPermissions: ['privacy'], grantedOrigins: ['http://a.example.com/*'] }
    expect(effectiveBrowserExtensionPermissions(manifest, granted)).toEqual({
      permissions: ['tabs', 'storage', 'privacy'],
      origins: ['https://*/*', 'http://a.example.com/*']
    })
    expect(
      containsBrowserExtensionPermissions(manifest, granted, { permissions: ['privacy'] })
    ).toBe(true)
    expect(containsBrowserExtensionPermissions(manifest, none, { permissions: ['privacy'] })).toBe(
      false
    )
    expect(
      containsBrowserExtensionPermissions(manifest, none, { origins: ['https://bank.test/login'] })
    ).toBe(true)
  })

  it('reads MV2 host entries out of permissions', () => {
    const mv2 = { permissions: ['tabs', '<all_urls>'], optional_permissions: ['https://x.test/*'] }
    expect(effectiveBrowserExtensionPermissions(mv2, none)).toEqual({
      permissions: ['tabs'],
      origins: ['<all_urls>']
    })
    expect(
      planBrowserExtensionPermissionRequest(
        { permissions: ['tabs'], optional_permissions: ['https://x.test/*'] },
        none,
        { origins: ['https://x.test/*'] }
      )
    ).toEqual({ kind: 'prompt', add: { permissions: [], origins: ['https://x.test/*'] } })
  })
})

describe('originPatternCovers', () => {
  it.each([
    ['<all_urls>', 'https://a.test/*', true],
    ['*://*/*', 'https://a.test/x', true],
    ['https://*.a.test/*', 'https://b.a.test/*', true],
    ['https://*.a.test/*', 'https://a.test/*', true],
    ['https://a.test/*', 'https://*.a.test/*', false],
    ['https://a.test/x/*', 'https://a.test/y', false],
    ['http://*/*', 'https://a.test/*', false],
    ['https://a.test/*', '<all_urls>', false]
  ])('%s covers %s: %s', (granted, requested, expected) => {
    expect(originPatternCovers(granted, requested)).toBe(expected)
  })
})
