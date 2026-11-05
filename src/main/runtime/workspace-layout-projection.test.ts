import { describe, expect, it, vi } from 'vitest'
import { runtimeLayoutLoadContext } from './workspace-layout-projection'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

describe('runtimeLayoutLoadContext', () => {
  // L286: a partition with no views still has known-empty views, so saved view-less diff tabs must drop.
  it('carries views for a partition that holds none yet', () => {
    const context = runtimeLayoutLoadContext(
      { getPtyBindingGeneration: () => undefined, getLayoutEditorViews: () => undefined },
      'local'
    )

    expect(context.editorViewsOf).toBeDefined()
    expect(context.editorViewsOf?.('repo-1::/w')).toBeUndefined()
  })
})
