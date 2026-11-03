import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants,
  type DocPreviewOwner
} from '../browser/document-preview/doc-preview-grant-registry'
import { isNativeChatVisualGuestLocation } from './native-chat-visual-guest-location'

const scratch = join(process.cwd(), 'profile', 'chat-scratch')
const session = 'a'.repeat(32)
afterEach(revokeAllDocPreviewGrants)

describe('chat visual guest identity', () => {
  it('recognizes only HTML immediately inside this profile’s scratch sessions', () => {
    for (const [path, expected] of [
      [join(scratch, session, 'mock.html'), true],
      [join(scratch, session, 'mock.svg'), false],
      [join(scratch, session, 'nested', 'mock.html'), false],
      [join(scratch, 'other', 'mock.html'), false],
      [join(`${scratch}-copy`, session, 'mock.html'), false]
    ] as const) {
      expect(isNativeChatVisualGuestLocation(pathToFileURL(path).href, scratch)).toBe(expected)
    }
    expect(isNativeChatVisualGuestLocation('https://example.com/mock.html', scratch)).toBe(false)
  })

  it('recognizes runtime scratch grants without extending ordinary file authority', () => {
    const root = `/profile/chat-scratch/${session}`
    const runtime: DocPreviewOwner = {
      kind: 'runtime',
      environmentId: 'host',
      worktreeRoot: root,
      worktreeSelector: `path:${root}`
    }
    const check = (owner: DocPreviewOwner, name = 'mock.html'): boolean => {
      const grant = mintDocPreviewGrant({
        owner,
        root,
        entryRelativePath: name,
        browserPageId: 'page'
      })
      return isNativeChatVisualGuestLocation(buildDocPreviewUrl(grant.id, name), scratch)
    }
    expect(check(runtime)).toBe(true)
    expect(check(runtime, 'image.png')).toBe(false)
    expect(check({ ...runtime, worktreeSelector: 'id:workspace' })).toBe(false)
    expect(check({ ...runtime, fileAccess: 'terminal-artifact' })).toBe(false)
    expect(check({ kind: 'ssh', connectionId: 'ssh' })).toBe(false)
  })
})
