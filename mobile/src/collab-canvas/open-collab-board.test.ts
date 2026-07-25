import { describe, expect, it, vi } from 'vitest'
import { collabBoardRoutePath, openCollabBoardFromHostPanel } from './open-collab-board'
import { buildCollabCanvasHtml } from './collab-canvas-html'
import { COLLAB_CANVAS_ENGINE_BYTES } from './collab-canvas-engine.generated'
import {
  mobileCollabCanvasRoomUri,
  resolveMobileCollabSyncOrigin
} from './collab-canvas-room'

describe('openCollabBoardFromHostPanel', () => {
  it('builds a host-panel path to the board route', () => {
    expect(collabBoardRoutePath({ hostId: 'node-b', boardId: 'board-1' })).toBe(
      '/h/node-b/board/board-1'
    )
  })

  it('pushes the route through the router', () => {
    const push = vi.fn()
    openCollabBoardFromHostPanel({ push }, { hostId: 'node-b', boardId: 'b2' })
    expect(push).toHaveBeenCalledWith('/h/node-b/board/b2')
  })
})

describe('buildCollabCanvasHtml (E1 offline shell)', () => {
  it('embeds offline engine JS and the mesh room URI', () => {
    const roomUri = mobileCollabCanvasRoomUri(resolveMobileCollabSyncOrigin(null), 'board-nord')
    const html = buildCollabCanvasHtml({ boardId: 'board-nord', roomUri })
    expect(html).toContain('board-nord')
    expect(html).toContain(roomUri)
    expect(html).toContain('OrcaCollabCanvasEngine')
    // No live CDN script tags
    expect(html).not.toMatch(/src=["']https?:\/\//)
    expect(COLLAB_CANVAS_ENGINE_BYTES).toBeGreaterThan(500)
  })
})
