import type { RuntimeTerminalPathResolution } from '../../../src/shared/runtime-types'
import {
  displayNameFromPreviewPath,
  type MobileFilePreviewRouteParams
} from '../files/mobile-file-preview-route'
import { classifyMobileArtifact } from './mobile-artifact-kind'

export type MobileTerminalFileTapTarget =
  | { kind: 'ignore' }
  | { kind: 'browser'; url: string }
  | { kind: 'preview'; params: MobileFilePreviewRouteParams }

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
    return { kind: 'browser', url: `file://${resolved.absolutePath}` }
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
