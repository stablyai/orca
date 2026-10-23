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
  const packageFiles = ['popup.html', 'assets/app.js', 'assets/deep/icon.png', 'Secret.json']
  // Stands in for the file system: any spelling of the private file names it.
  const isPrivate = (resource: string) => resource.toLowerCase() === 'secret.json'

  it('lists the package files a pattern matches, minus private ones', () => {
    const manifest = { web_accessible_resources: [{ resources: ['*'], matches: ['<all_urls>'] }] }
    expect(
      withPrivateFilesHiddenFromWebAccessibleResources(manifest, packageFiles, isPrivate)
    ).toEqual({
      web_accessible_resources: [
        {
          resources: ['popup.html', 'assets/app.js', 'assets/deep/icon.png'],
          matches: ['<all_urls>']
        }
      ]
    })
  })

  it('keeps named resources unless they are a private file in another spelling', () => {
    const manifest = {
      web_accessible_resources: [
        { resources: ['SECRET.JSON', 'popup.html', '/assets/*.js'], matches: ['<all_urls>'] }
      ]
    }
    expect(
      withPrivateFilesHiddenFromWebAccessibleResources(manifest, packageFiles, isPrivate)
        .web_accessible_resources
    ).toEqual([{ resources: ['popup.html', 'assets/app.js'], matches: ['<all_urls>'] }])
  })
})
