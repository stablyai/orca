import { describe, expect, it } from 'vitest'
import { crossStoreCreateLineage } from './runtime-worktree-lineage-recording'

const parent = {
  installationId: 'home-installation',
  workspaceKey: 'folder:bot-home' as const,
  instanceId: 'bot-home'
}

describe('crossStoreCreateLineage', () => {
  it("records a parent orchestration placed on another machine as orchestration's", () => {
    expect(
      crossStoreCreateLineage({
        crossStoreParent: parent,
        crossStoreParentInferredFrom: 'orchestration-context'
      })
    ).toEqual({
      kind: 'crossStore',
      parent,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' }
    })
  })
})
