import { describe, expect, it } from 'vitest'
import {
  samePermissionSummary,
  summarizeManifestPermissions
} from './browser-extension-permission-summary'

describe('summarizeManifestPermissions', () => {
  it('splits API permissions from every place a manifest grants host access', () => {
    expect(
      summarizeManifestPermissions({
        permissions: ['tabs', 'storage', 'https://legacy.example/*', 'tabs'],
        host_permissions: ['<all_urls>'],
        content_scripts: [{ matches: ['https://*.bank.example/*'] }, { js: ['x.js'] }, null]
      })
    ).toEqual({
      permissions: ['storage', 'tabs'],
      hostPermissions: ['<all_urls>', 'https://*.bank.example/*', 'https://legacy.example/*']
    })
  })

  it('treats a missing or malformed manifest as asking for nothing', () => {
    expect(summarizeManifestPermissions(null)).toEqual({ permissions: [], hostPermissions: [] })
    expect(summarizeManifestPermissions({ permissions: 'tabs' })).toEqual({
      permissions: [],
      hostPermissions: []
    })
  })
})

describe('permission comparisons', () => {
  const approved = summarizeManifestPermissions({
    permissions: ['storage', 'tabs'],
    host_permissions: ['https://*/*']
  })

  it('matches the same access listed in a different order', () => {
    const downloaded = summarizeManifestPermissions({
      host_permissions: ['https://*/*'],
      permissions: ['tabs', 'storage']
    })
    expect(samePermissionSummary(downloaded, approved)).toBe(true)
  })

  it('flags a download that asks for more or different access than approved', () => {
    const extraPermission = summarizeManifestPermissions({
      permissions: ['storage', 'tabs', 'nativeMessaging'],
      host_permissions: ['https://*/*']
    })
    const extraContentScript = summarizeManifestPermissions({
      permissions: ['storage', 'tabs'],
      host_permissions: ['https://*/*'],
      content_scripts: [{ matches: ['<all_urls>'] }]
    })
    expect(samePermissionSummary(extraPermission, approved)).toBe(false)
    expect(samePermissionSummary(extraContentScript, approved)).toBe(false)
  })
})
