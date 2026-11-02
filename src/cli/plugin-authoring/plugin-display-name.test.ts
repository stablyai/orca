import { describe, expect, it } from 'vitest'
import { pluginDisplayNameFromId } from './plugin-display-name'

describe('pluginDisplayNameFromId', () => {
  it.each([
    ['pr-queue', 'PR Queue'],
    ['api-explorer', 'API Explorer'],
    ['ci-status', 'CI Status'],
    ['github-pr-ui', 'Github PR UI'],
    ['k8s-pods', 'K8s Pods'],
    ['notes', 'Notes'],
    ['prism', 'Prism'],
    ['idle', 'Idle'],
    ['url-shortener', 'URL Shortener'],
    ['apis', 'Apis'],
    ['my--tool-', 'My Tool'],
    ['2fa-codes', '2fa Codes']
  ])('%s → %s', (id, name) => {
    expect(pluginDisplayNameFromId(id)).toBe(name)
  })
})
