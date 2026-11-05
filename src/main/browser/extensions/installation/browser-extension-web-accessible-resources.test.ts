import { describe, expect, it } from 'vitest'
import { withPrivateFilesHiddenFromWebAccessibleResources } from './browser-extension-web-accessible-resources'

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
