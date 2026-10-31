import type { RuntimeFilePreviewResult } from '../../shared/runtime-file-contracts'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/runtime-environment-registry-root'
import type { DocPreviewOwner } from './doc-preview-grant-registry'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { posix } from 'node:path'

const TIMEOUT_MS = 15_000

function isFilePreview(value: unknown): value is RuntimeFilePreviewResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    typeof value.content === 'string' &&
    'isBinary' in value &&
    typeof value.isBinary === 'boolean' &&
    (!('mimeType' in value) || typeof value.mimeType === 'string')
  )
}

/** Called only after the page grant has authorized this path. The host still checks its file grant. */
export async function readDocPreviewTerminalFile(
  owner: Extract<DocPreviewOwner, { kind: 'runtime' }>,
  absolutePath: string
): Promise<RuntimeFilePreviewResult> {
  const root = getRuntimeEnvironmentRegistryRoot()
  const environment = resolveEnvironment(root, owner.environmentId)
  const revision = environment.pairingRevision ?? environment.createdAt
  const resolved = await callRuntimeEnvironment(
    root,
    owner.environmentId,
    'files.resolveTerminalPath',
    { worktree: owner.worktreeSelector, pathText: absolutePath },
    TIMEOUT_MS,
    revision
  )
  if (!resolved.ok) {
    throw new Error(resolved.error.message)
  }
  const resolution = resolved.result
  const target =
    typeof resolution === 'object' && resolution !== null && 'openTarget' in resolution
      ? resolution.openTarget
      : null
  if (
    typeof target !== 'object' ||
    target === null ||
    !('kind' in target) ||
    !('absolutePath' in target) ||
    typeof target.absolutePath !== 'string'
  ) {
    throw new Error('Update Orca on the paired machine to preview files outside its workspaces.')
  }
  // A symlink must not turn an authorized asset into a read outside the document's directory.
  const samePath = isWindowsAbsolutePathLike(absolutePath)
    ? normalizeRuntimePathForComparison(target.absolutePath) ===
      normalizeRuntimePathForComparison(absolutePath)
    : target.absolutePath === absolutePath
  if (!samePath) {
    throw new Error('The preview file path changed on its host.')
  }
  let method: string
  let params: unknown
  if (
    target.kind === 'absolute-file' &&
    'grantId' in target &&
    typeof target.grantId === 'string'
  ) {
    method = 'files.readTerminalArtifactPreview'
    params = {
      worktree: owner.worktreeSelector,
      grantId: target.grantId,
      absolutePath: target.absolutePath
    }
  } else if (
    target.kind === 'worktree-file' &&
    'relativePath' in target &&
    typeof target.relativePath === 'string'
  ) {
    method = 'files.readDocPreview'
    const directory = posix.dirname(target.relativePath.replace(/\\/g, '/'))
    params = {
      worktree: owner.worktreeSelector,
      relativePath: target.relativePath,
      // A directory entry cannot grant a symlinked file outside the approved asset directory.
      entryRelativePath: directory === '.' ? target.relativePath : directory,
      implicitRootRelativePath: null,
      authorizedRootRelativePaths: [directory === '.' ? '' : directory]
    }
  } else {
    throw new Error('Update Orca on the paired machine to preview files outside its workspaces.')
  }
  const response = await callRuntimeEnvironment(
    root,
    owner.environmentId,
    method,
    params,
    TIMEOUT_MS,
    revision
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  if (!isFilePreview(response.result)) {
    throw new Error('The paired machine returned an unreadable file preview.')
  }
  return response.result
}
