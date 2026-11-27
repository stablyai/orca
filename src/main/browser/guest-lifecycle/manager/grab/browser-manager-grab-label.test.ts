import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from '../browser-manager'
import { installDocPreviewGuestPolicy } from '../../../document-preview/doc-preview-guest-policy'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../../../document-preview/doc-preview-grant-registry'
import { buildDocPreviewUrl } from '../../../../../shared/document-preview/doc-preview-scheme'
import { attachGrabExecutionTransport } from '../../../element-grab/testing/grab-execution-transport-fixture'
import { executeGrabScript } from '../../../element-grab/grab-guest-execution'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  WebContentsView: class {},
  app: { getPath: () => '/downloads' },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))

afterEach(() => revokeAllDocPreviewGrants())

describe('palette footprint ownership', () => {
  it('rejects another renderer clearing a footprint, including after guest loss, while its owner can still clear it', async () => {
    const manager = new BrowserManager()
    const grant = mintDocPreviewGrant({
      owner: {
        kind: 'runtime',
        environmentId: 'synthetic-env',
        worktreeSelector: 'synthetic',
        worktreeRoot: '/synthetic/docs'
      },
      root: '/synthetic/docs',
      entryRelativePath: 'index.html',
      browserPageId: 'preview-page'
    })
    let destroyed = false
    const guest = attachGrabExecutionTransport(
      Object.assign(new EventEmitter(), {
        isDestroyed: () => destroyed,
        getURL: () => buildDocPreviewUrl(grant.id, 'index.html'),
        setWindowOpenHandler: () => {},
        setWebRTCIPHandlingPolicy: () => {},
        executeJavaScript: async () => true
      })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the document policy and footprint delivery only use the members above.
    const contents = guest as unknown as Electron.WebContents
    const dispose = installDocPreviewGuestPolicy(contents, { id: 17, send: () => {} })
    try {
      await expect(
        manager.setGrabLabelAvoidArea(
          'preview-page',
          { x: 10, y: 20, width: 100, height: 40, frameWidth: 640, frameHeight: 480 },
          17
        )
      ).resolves.toBe(true)
      await expect(manager.setGrabLabelAvoidArea('preview-page', null, 23)).resolves.toBe(false)

      destroyed = true
      guest.emit('destroyed')

      await expect(manager.setGrabLabelAvoidArea('preview-page', null, 23)).resolves.toBe(false)
      await expect(manager.setGrabLabelAvoidArea('preview-page', null, 17)).resolves.toBe(true)
    } finally {
      dispose()
    }
  })

  it('keeps a completed arm successful while the footprint lane is busy, then applies the newest footprint', async () => {
    const manager = new BrowserManager()
    const grant = mintDocPreviewGrant({
      owner: {
        kind: 'runtime',
        environmentId: 'synthetic-env',
        worktreeSelector: 'synthetic',
        worktreeRoot: '/synthetic/docs'
      },
      root: '/synthetic/docs',
      entryRelativePath: 'index.html',
      browserPageId: 'preview-page'
    })
    const labels: string[] = []
    let releaseHold: ((value: boolean) => void) | undefined
    let hold: Promise<boolean | null> | undefined
    const guest = attachGrabExecutionTransport(
      Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        getURL: () => buildDocPreviewUrl(grant.id, 'index.html'),
        setWindowOpenHandler: () => {},
        setWebRTCIPHandlingPolicy: () => {},
        executeJavaScript: async (code: string): Promise<unknown> => {
          if (code.includes('__orca-grab-host')) {
            // Another script request queues behind the arm and holds the lane once it ends.
            hold = executeGrabScript(contents, 'hold')
            return (action: string, argument: unknown) => {
              if (action === 'setLabelAvoidArea') {
                labels.push(JSON.stringify(argument))
              }
              return true
            }
          }
          if (code === 'hold') {
            return new Promise<boolean>((resolve) => {
              releaseHold = resolve
            })
          }
          return true
        }
      })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the document policy, picker and footprint delivery only use the members above.
    const contents = guest as unknown as Electron.WebContents
    const dispose = installDocPreviewGuestPolicy(contents, { id: 17, send: () => {} })
    const area = (x: number) => ({
      x,
      y: 20,
      width: 100,
      height: 40,
      frameWidth: 640,
      frameHeight: 480
    })
    try {
      await expect(manager.setGrabLabelAvoidArea('preview-page', area(111), 17)).resolves.toBe(true)
      labels.length = 0

      await expect(manager.setGrabMode('preview-page', true, contents)).resolves.toBe(true)
      const newest = manager.setGrabLabelAvoidArea('preview-page', area(333), 17)
      await Promise.resolve()
      expect(labels).toEqual([])

      releaseHold?.(true)
      await expect(hold).resolves.toBe(true)
      await expect(newest).resolves.toBe(true)
      expect(labels.at(-1)).toContain('"x":333')
      expect(labels.some((code) => code.includes('"x":111'))).toBe(false)
    } finally {
      dispose()
    }
  })
})
