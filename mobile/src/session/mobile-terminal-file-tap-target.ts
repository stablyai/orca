import type { RuntimeTerminalPathResolution } from '../../../src/shared/runtime-types'
import { filesystemPathToFileUri } from '../../../src/shared/file-uri-path'
import {
  displayNameFromPreviewPath,
  type MobileFilePreviewRouteParams
} from '../files/mobile-file-preview-route'
import { classifyMobileArtifact } from './mobile-artifact-kind'

export type MobileTerminalFileTapTarget =
  | { kind: 'ignore' }
  | { kind: 'browser'; url: string }
  | { kind: 'preview'; params: MobileFilePreviewRouteParams }

/**
 * Classifies a host-resolved terminal path into the mobile surface that should
 * open it. The host already enforces the worktree boundary; this helper keeps
 * UI routing and cross-platform file URL normalization in one tested place.
 */
export function getMobileTerminalFileTapTarget(args: {
  hostId: string
  worktreeId: string
  worktreeName?: string
  resolved: RuntimeTerminalPathResolution
}): MobileTerminalFileTapTarget {
  const { hostId, worktreeId, worktreeName, resolved } = args
  if (!resolved.exists || resolved.isDirectory || !resolved.relativePath) {
    return { kind: 'ignore' }
  }

  // HTML keeps the desktop-like browser path when the host can provide an
  // absolute file URL; all other artifacts open directly in the phone previewer.
  if (classifyMobileArtifact(resolved.relativePath) === 'html' && resolved.absolutePath) {
    return { kind: 'browser', url: filesystemPathToFileUri(resolved.absolutePath) }
  }

  return {
    kind: 'preview',
    params: {
      hostId,
      worktreeId,
      relativePath: resolved.relativePath,
      name: displayNameFromPreviewPath(resolved.relativePath),
      worktreeName
    }
  }
}
