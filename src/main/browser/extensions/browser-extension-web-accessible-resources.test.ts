import { describe, expect, it } from 'vitest'
import {
  withPrivateFilesHiddenFromWebAccessibleResources,
  withStaticWebAccessibleResources
} from './browser-extension-web-accessible-resources'

describe('withStaticWebAccessibleResources', () => {
  it('turns off dynamic URLs and keeps every other field', () => {
    const manifest = {
      name: 'Vault',
      web_accessible_resources: [
        { resources: ['overlay/menu.html'], matches: ['<all_urls>'], use_dynamic_url: true },
        { resources: ['icon.png'], matches: ['<all_urls>'] }
      ]
    }
    expect(withStaticWebAccessibleResources(manifest)).toEqual({
      name: 'Vault',
      web_accessible_resources: [
        { resources: ['overlay/menu.html'], matches: ['<all_urls>'], use_dynamic_url: false },
        { resources: ['icon.png'], matches: ['<all_urls>'] }
      ]
    })
  })

  it('leaves manifests without web-accessible resources unchanged', () => {
    const manifest = { name: 'Plain' }
    expect(withStaticWebAccessibleResources(manifest)).toBe(manifest)
  })
})

describe('withPrivateFilesHiddenFromWebAccessibleResources', () => {
  const packageFiles = [
    'popup.html',
    'assets/app.js',
    'assets/deep/icon.png',
    'orca-extension-api-token.json',
    'orca-original-manifest.json'
  ]
  const privateFiles = ['orca-extension-api-token.json', 'orca-original-manifest.json']

  it('turns a catch-all pattern into the package files minus the private ones', () => {
    const manifest = { web_accessible_resources: [{ resources: ['*'], matches: ['<all_urls>'] }] }
    expect(
      withPrivateFilesHiddenFromWebAccessibleResources(manifest, packageFiles, privateFiles)
    ).toEqual({
      web_accessible_resources: [
        {
          resources: ['popup.html', 'assets/app.js', 'assets/deep/icon.png'],
          matches: ['<all_urls>']
        }
      ]
    })
  })

  it('expands only patterns that reach a private file and keeps the rest as written', () => {
    const manifest = {
      web_accessible_resources: [{ resources: ['/*.json', 'assets/*'], matches: ['<all_urls>'] }]
    }
    const result = withPrivateFilesHiddenFromWebAccessibleResources(
      manifest,
      packageFiles,
      privateFiles
    )
    expect(result.web_accessible_resources).toEqual([
      { resources: ['assets/*'], matches: ['<all_urls>'] }
    ])
  })

  it('leaves manifests whose patterns never reach a private file unchanged', () => {
    const manifest = {
      web_accessible_resources: [{ resources: ['assets/*.js'], matches: ['<all_urls>'] }]
    }
    expect(
      withPrivateFilesHiddenFromWebAccessibleResources(manifest, packageFiles, privateFiles)
    ).toEqual(manifest)
  })
})
