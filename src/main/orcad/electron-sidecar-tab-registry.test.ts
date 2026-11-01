import { describe, expect, it } from 'vitest'
import { ElectronSidecarTabRegistry } from './electron-sidecar-tab-registry'

describe('ElectronSidecarTabRegistry', () => {
  it('preserves requested ids and fences explicit worktree scope', () => {
    const registry = new ElectronSidecarTabRegistry()
    registry.register('sidecar-a', 'public-a', 'worktree-a')
    registry.register('sidecar-b', 'public-b', 'worktree-b')

    expect(registry.require('public-a', 'worktree-a').sidecarPageId).toBe('sidecar-a')
    expect(() => registry.require('public-a', 'worktree-b')).toThrow(
      expect.objectContaining({ code: 'browser_tab_not_found' })
    )
    expect(registry.active('worktree-b').publicPageId).toBe('public-b')
  })

  it('rewrites sidecar ids, worktree-relative indices, and stale pages', () => {
    const registry = new ElectronSidecarTabRegistry()
    registry.register('sidecar-a', 'public-a', 'worktree-a')
    registry.register('sidecar-b', 'public-b', 'worktree-b')
    registry.register('sidecar-c', 'public-c', 'worktree-a')

    const tabs = registry.reconcileTabs(
      [
        { browserPageId: 'sidecar-a', active: false },
        { browserPageId: 'sidecar-b', active: true },
        { browserPageId: 'sidecar-c', active: true }
      ],
      'worktree-a'
    )
    expect(tabs).toEqual([
      expect.objectContaining({ browserPageId: 'public-a', index: 0 }),
      expect.objectContaining({ browserPageId: 'public-c', index: 1 })
    ])
    expect(registry.active('worktree-a').publicPageId).toBe('public-c')

    registry.reconcileTabs([{ browserPageId: 'sidecar-c' }])
    expect(() => registry.require('public-a')).toThrow(
      expect.objectContaining({ code: 'browser_tab_not_found' })
    )
  })

  it('keeps a listed popup with its opener: scoped, listed last, and handing back to it on close', () => {
    const registry = new ElectronSidecarTabRegistry()
    registry.register('sidecar-a', 'public-a', 'worktree-a')
    registry.register('sidecar-b', 'public-b', 'worktree-a')

    const tabs = registry.reconcileTabs(
      [
        { browserPageId: 'sidecar-a' },
        { browserPageId: 'sidecar-b', active: true },
        { browserPageId: 'popup-7', openerBrowserPageId: 'sidecar-b' }
      ],
      'worktree-a'
    )
    expect(tabs[2]).toEqual(
      expect.objectContaining({ browserPageId: 'popup-7', openerBrowserPageId: 'public-b' })
    )
    expect(registry.require('popup-7', 'worktree-a').sidecarPageId).toBe('popup-7')
    expect(registry.active('worktree-a').publicPageId).toBe('public-b')

    registry.register('sidecar-c', 'public-c', 'worktree-a')
    expect(registry.pageAt('worktree-a', 2).publicPageId).toBe('public-c')
    expect(registry.pageAt('worktree-a', 3).publicPageId).toBe('popup-7')

    const popup = registry.require('popup-7')
    registry.setActive(popup)
    registry.delete(popup)
    expect(registry.active('worktree-a').publicPageId).toBe('public-b')
  })

  it('rewrites page ids in tab and command results', () => {
    const registry = new ElectronSidecarTabRegistry()
    registry.register('sidecar-a', 'public-a', 'worktree-a')

    expect(
      registry.rewriteResult({
        browserPageId: 'sidecar-a',
        tab: {
          browserPageId: 'sidecar-a',
          certificateFailure: { browserPageId: 'sidecar-a', challengeId: 'challenge-a' }
        }
      })
    ).toEqual({
      browserPageId: 'public-a',
      tab: {
        browserPageId: 'public-a',
        certificateFailure: { browserPageId: 'public-a', challengeId: 'challenge-a' }
      }
    })
  })
})
