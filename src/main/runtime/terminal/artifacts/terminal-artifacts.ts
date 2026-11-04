import { constants } from 'node:fs/promises'
import { RuntimeTerminalFileGrants, type RuntimeTerminalFileGrantHost } from './file-grants'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadResult,
  RuntimeTerminalPathResolution
} from '../../../../shared/runtime-file-contracts'
import { canonicalPathForArtifactComparison, truncateMobileFilePreview } from './artifact-integrity'
import {
  openLocalTerminalArtifactGrant,
  readLocalTerminalArtifactFileFromHandle,
  readLocalTerminalArtifactPreviewFromHandle
} from './local-artifact-read'
import { statLocalTerminalArtifact } from './artifact-stat'
import { assertPreviewWithinTransportBudget } from '../../files/file-preview-budget'
import { isMobileBinaryPath } from '../../files/mobile-file-kind'
import { writeTerminalArtifactFile } from './artifact-write'

export class RuntimeTerminalArtifacts {
  private readonly grants: RuntimeTerminalFileGrants

  constructor(host: RuntimeTerminalFileGrantHost) {
    this.grants = new RuntimeTerminalFileGrants(host)
  }

  async resolveAbsoluteFileGrant(args: {
    worktreeId: string
    absolutePath: string
    clientId?: string
  }): Promise<RuntimeTerminalPathResolution> {
    // Why: the grant binds the canonical path so later reads cannot be redirected through a symlink.
    const canonicalPath = await canonicalPathForArtifactComparison(args.absolutePath)
    const { stats, contentDigest } = await statLocalTerminalArtifact(canonicalPath)
    const isDirectory = stats.isDirectory()
    const grant = isDirectory
      ? null
      : this.grants.createTerminalFileGrant({
          worktreeId: args.worktreeId,
          absolutePath: canonicalPath,
          clientId: args.clientId,
          stats,
          contentDigest
        })
    return {
      worktree: args.worktreeId,
      relativePath: null,
      absolutePath: canonicalPath,
      exists: true,
      isDirectory,
      openTarget: grant
        ? {
            kind: 'absolute-file',
            provider: grant.provider,
            absolutePath: canonicalPath,
            grantId: grant.id
          }
        : undefined
    }
  }

  async readTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ): Promise<RuntimeFileReadResult> {
    const { grant, target } = await this.grants.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (isMobileBinaryPath(grant.absolutePath)) {
      throw new Error('binary_file')
    }
    let content: string
    const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
    try {
      content = await readLocalTerminalArtifactFileFromHandle(handle, grant)
    } finally {
      await handle.close()
    }
    this.grants.refreshTerminalFileGrant(grant)
    const truncated = truncateMobileFilePreview(content)

    return {
      worktree: target.worktree.id,
      relativePath: grant.absolutePath,
      content: truncated.content,
      truncated: truncated.truncated,
      byteLength: truncated.byteLength
    }
  }

  async readTerminalArtifactPreview(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string,
    maxContentBytes?: number
  ): Promise<RuntimeFilePreviewResult> {
    const { grant } = await this.grants.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
    try {
      const preview = await readLocalTerminalArtifactPreviewFromHandle(
        handle,
        grant,
        maxContentBytes
      )
      this.grants.refreshTerminalFileGrant(grant)
      return assertPreviewWithinTransportBudget(preview, maxContentBytes)
    } finally {
      await handle.close()
    }
  }

  revokeTerminalFileGrantsForClient(clientId: string): void {
    this.grants.revokeTerminalFileGrantsForClient(clientId)
  }

  writeTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    content: string,
    clientId?: string
  ): Promise<{ ok: true }> {
    return writeTerminalArtifactFile(
      this.grants,
      worktreeSelector,
      grantId,
      absolutePath,
      content,
      clientId
    )
  }
}
