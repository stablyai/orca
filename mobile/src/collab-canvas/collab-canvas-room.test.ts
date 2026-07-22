import { describe, expect, it } from 'vitest'
import {
  MOBILE_DEFAULT_COLLAB_SYNC_ORIGIN,
  mobileCollabCanvasRoomUri,
  resolveMobileCollabSyncOrigin
} from './collab-canvas-room'

describe('mobile collab canvas room', () => {
  it('defaults to mesh node-a, never Cloudflare', () => {
    expect(MOBILE_DEFAULT_COLLAB_SYNC_ORIGIN).toBe('ws://node-a:5858')
    expect(resolveMobileCollabSyncOrigin(null)).toBe('ws://node-a:5858')
    expect(resolveMobileCollabSyncOrigin(undefined)).not.toMatch(/cloudflare|workers\.dev/i)
  })

  it('builds the same /connect/<boardId> path as desktop', () => {
    expect(mobileCollabCanvasRoomUri('ws://node-a:5858', 'board-1')).toBe(
      'ws://node-a:5858/connect/board-1'
    )
  })

  it('accepts operator override host:port', () => {
    expect(resolveMobileCollabSyncOrigin('node-a:5858')).toBe('ws://node-a:5858')
  })
})
