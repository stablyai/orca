import {
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree,
  type SourceControlTreeNode
} from '../../../src/shared/source-control-tree'
import type { MobileGitChangedFile } from './git-compare-reply-schema'

export type MobileCommitTreeNode = SourceControlTreeNode<MobileGitChangedFile, 'commit'>

// Desktop's committed-file tree: compacted folders, shown expanded; files in the order they render.
export function buildMobileCommitFileTree(
  files: MobileGitChangedFile[],
  collapsedDirectoryKeys: ReadonlySet<string> = new Set()
): MobileCommitTreeNode[] {
  return flattenSourceControlTree(
    compactSourceControlTree(buildSourceControlTree('commit', files)),
    collapsedDirectoryKeys
  )
}

// Review Changes steps through files in the tree's order, whatever is collapsed.
export function orderMobileCommitFiles(files: MobileGitChangedFile[]): MobileGitChangedFile[] {
  return buildMobileCommitFileTree(files).flatMap((node) =>
    node.type === 'file' ? [node.entry] : []
  )
}
