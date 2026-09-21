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
