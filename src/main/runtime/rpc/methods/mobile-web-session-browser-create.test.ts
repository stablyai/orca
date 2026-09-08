import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileWebSessionBrowserCreateResultSchema } from '../../../../shared/mobile-web/session-operation-contract'
import { MOBILE_WEB_SESSION_BROWSER_CREATE_METHOD } from './mobile-web-session-browser-create'
import { BROWSER_CORE_METHODS } from './browser-core'
import { FILE_METHODS } from './files'
import { sessionFixture } from './mobile-web-session-test-fixture'
import { isStreamingMethod } from '../core'

const create = BROWSER_CORE_METHODS.find((method) => method.name === 'browser.tabCreate')!
const resolve = FILE_METHODS.find((method) => method.name === 'files.resolveTerminalPath')!
if (isStreamingMethod(create) || isStreamingMethod(resolve)) {
  throw new Error('Invalid methods')
}

afterEach(() => vi.restoreAllMocks())

describe('host session browser creation', () => {
  it('confines local file URLs on the owning host and returns the host page id', async () => {
    const f = sessionFixture()
    const path = vi.spyOn(resolve, 'handler').mockResolvedValue({
      worktree: 'folder:workspace',
      exists: true,
      isDirectory: false,
      openTarget: {
        kind: 'worktree-file',
        provider: 'local',
        absolutePath: '/workspace/file.txt'
      }
    })
    const browser = vi.spyOn(create, 'handler').mockResolvedValue({ browserPageId: 'host-page' })
    const result = await MOBILE_WEB_SESSION_BROWSER_CREATE_METHOD.handler(
      { ...f.params, url: 'file:///workspace/file.txt' },
      f.context
    )
    expect(MobileWebSessionBrowserCreateResultSchema.parse(result).browserPageId).toBe('host-page')
    expect(path).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: f.params.worktree, pathText: '/workspace/file.txt' }),
      f.context
    )
    expect(browser).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: f.params.worktree,
        url: 'file:///workspace/file.txt',
        activate: true
      }),
      f.context
    )
  })

  it.each(['ssh', 'outside'])(
    'refuses %s file targets without local substitution',
    async (kind) => {
      const f = sessionFixture()
      vi.spyOn(resolve, 'handler').mockResolvedValue({
        worktree: 'folder:workspace',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: kind === 'outside' ? 'external-file' : 'worktree-file',
          provider: kind === 'ssh' ? 'ssh' : 'local',
          absolutePath: '/private/file'
        }
      })
      const browser = vi.spyOn(create, 'handler')
      await expect(
        MOBILE_WEB_SESSION_BROWSER_CREATE_METHOD.handler(
          { ...f.params, url: 'file:///workspace/file.txt' },
          f.context
        )
      ).rejects.toThrow()
      expect(browser).not.toHaveBeenCalled()
    }
  )

  it('refuses every URL scheme when the selector names another workspace', async () => {
    const f = sessionFixture()
    f.setSnapshot({ ...f.snapshot, worktree: 'folder:other' })
    const browser = vi.spyOn(create, 'handler')
    await expect(
      MOBILE_WEB_SESSION_BROWSER_CREATE_METHOD.handler(
        { ...f.params, url: 'https://example.com' },
        f.context
      )
    ).rejects.toThrow('selector_not_found')
    expect(browser).not.toHaveBeenCalled()
  })

  it('does not retry an ambiguous browser creation result', async () => {
    const f = sessionFixture()
    const browser = vi.spyOn(create, 'handler').mockRejectedValue(new Error('lost acknowledgement'))
    await expect(
      MOBILE_WEB_SESSION_BROWSER_CREATE_METHOD.handler(
        { ...f.params, url: 'https://example.com' },
        f.context
      )
    ).rejects.toThrow('lost acknowledgement')
    expect(browser).toHaveBeenCalledTimes(1)
  })
})
