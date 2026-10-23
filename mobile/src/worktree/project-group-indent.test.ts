import { describe, expect, it } from 'vitest'
import { projectGroupHeaderIndent, projectGroupRowIndent } from './project-group-indent'

const DEPTHS = [0, 1, 2, 6, 9, undefined]

describe('project-group indent', () => {
  it('steps headers 10 px a level, up to six levels', () => {
    expect(DEPTHS.map(projectGroupHeaderIndent)).toEqual([0, 10, 20, 60, 60, 0])
  })

  it('steps a hand-made group’s rows, folder workspaces too, a full tree step a level', () => {
    for (const workspaceKind of ['git', 'folder-workspace', undefined] as const) {
      expect(
        DEPTHS.map((projectGroupDepth) =>
          projectGroupRowIndent({ workspaceKind, projectGroupDepth })
        )
      ).toEqual([0, 18, 36, 108, 108, 0])
    }
  })

  it('steps a folder-scanned group’s rows by the header step, its folder workspaces one level less', () => {
    const indent = (workspaceKind: 'git' | 'folder-workspace', projectGroupDepth: number) =>
      projectGroupRowIndent({ workspaceKind, projectGroupDepth, inFolderScanGroup: true })
    expect([1, 2, 7].map((depth) => indent('git', depth))).toEqual([10, 20, 60])
    expect([1, 2, 7, 9].map((depth) => indent('folder-workspace', depth))).toEqual([0, 10, 60, 60])
  })
})
