import type { RuntimeFilePreviewResult } from '../../shared/runtime-file-contracts'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/runtime-environment-registry-root'
import {
  resolveCanonicalDocPreviewPath,
  resolveDocPreviewAuthorityPaths,
  toRuntimeWorktreeRelativeDirectoryPath,
  toRuntimeWorktreeRelativePath,
  type DocPreviewGrant
} from './doc-preview-grant-registry'
import type { RuntimeDocPreviewReadParams } from './doc-preview-file-reader'
import { resolveEnvironment } from '../../shared/runtime-environment-store'

const TIMEOUT_MS = 15_000
const UPDATE_REQUIRED_MESSAGE =
  'Update Orca on the paired machine to preview files outside its workspaces.'

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

export type DocPreviewTerminalRead =
  | { preview: RuntimeFilePreviewResult }
  | { workspaceParams: RuntimeDocPreviewReadParams }

/** Called only after the page grant has authorized this path. The host still checks its file grant. */
export async function readDocPreviewTerminalFile(
  grant: DocPreviewGrant,
  absolutePath: string
): Promise<DocPreviewTerminalRead> {
  const owner = grant.owner
  if (owner.kind !== 'runtime') {
    throw new Error('Not found')
  }
  const root = getRuntimeEnvironmentRegistryRoot()
  const environment = resolveEnvironment(root, owner.environmentId)
  const revision = environment.pairingRevision ?? environment.createdAt
  const call = async (method: string, params: unknown): Promise<unknown> => {
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
    return response.result
  }
  const resolve = (pathText: string): Promise<unknown> =>
    call('files.resolveTerminalPath', { worktree: owner.worktreeSelector, pathText })

  const resolution = await resolve(absolutePath)
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
    throw new Error(UPDATE_REQUIRED_MESSAGE)
  }
  const targetPath = target.absolutePath
  // Why: compare host-canonical paths, so /tmp vs /private/tmp or a case-folded name still match but a symlink out of the approved directories does not.
  const canonicalPath = await resolveCanonicalDocPreviewPath(grant, absolutePath, async (path) => {
    if (path === absolutePath) {
      return targetPath
    }
    const resolved = await resolve(path)
    if (
      typeof resolved !== 'object' ||
      resolved === null ||
      !('absolutePath' in resolved) ||
      typeof resolved.absolutePath !== 'string'
    ) {
      throw new Error(UPDATE_REQUIRED_MESSAGE)
    }
    return resolved.absolutePath
  })
  if (canonicalPath !== targetPath) {
    throw new Error('The preview file path changed on its host.')
  }
  if (
    target.kind === 'absolute-file' &&
    'grantId' in target &&
    typeof target.grantId === 'string'
  ) {
    const preview = await call('files.readTerminalArtifactPreview', {
      worktree: owner.worktreeSelector,
      grantId: target.grantId,
      absolutePath: targetPath
    })
    if (!isFilePreview(preview)) {
      throw new Error('The paired machine returned an unreadable file preview.')
    }
    return { preview }
  }
  if (
    target.kind === 'worktree-file' &&
    'relativePath' in target &&
    typeof target.relativePath === 'string'
  ) {
    // Why: the host must check the user-approved folders, not the target's own folder, so a nested symlink cannot step outside them.
    const approvedRoots = resolveDocPreviewAuthorityPaths(grant)
      .authorizedRootPaths.filter((root) => toRuntimeWorktreeRelativePath(root, absolutePath))
      .map((root) =>
        toRuntimeWorktreeRelativePath(root, owner.worktreeRoot)
          ? ''
          : toRuntimeWorktreeRelativeDirectoryPath(owner.worktreeRoot, root)
      )
      .filter((root): root is string => root !== null)
    if (approvedRoots.length === 0) {
      throw new Error('Not found')
    }
    return {
      workspaceParams: {
        worktree: owner.worktreeSelector,
        relativePath: target.relativePath,
        // A folder entry grants nothing itself; with only the workspace approved, its boundary already bounds the target.
        entryRelativePath: approvedRoots.find((root) => root !== '') ?? target.relativePath,
        implicitRootRelativePath: null,
        authorizedRootRelativePaths: approvedRoots
      }
    }
  }
  throw new Error(UPDATE_REQUIRED_MESSAGE)
}
