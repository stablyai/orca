// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithResolveAllowedTerminalArtifactPath } from './runtime-file-commands-resolve-allowed-terminal-artifact-path'
import type { TerminalFileGrant } from './runtime-file-commands-mobile-file-list-limit'
import {
  MOBILE_FILE_READ_MAX_BYTES,
  assertPreviewWithinTransportBudget
} from './runtime-file-commands-mobile-file-list-limit'
import type { RuntimeFilePreviewResult, RuntimeFileReadResult } from '../../shared/runtime-types'
import { isMobileBinaryPath } from './runtime-file-command-host'
import {
  openLocalTerminalArtifactGrant,
  readLocalTerminalArtifactFileFromHandle,
  readLocalTerminalArtifactPreviewFromHandle
} from './runtime-file-commands-terminal-file-paths'
import { constants } from 'node:fs/promises'
import { truncateMobileFilePreview } from './runtime-file-commands-terminal-artifact-access'

export class RuntimeFileCommandsWithRevokeTerminalFileGrantsForClient extends RuntimeFileCommandsWithResolveAllowedTerminalArtifactPath {
  revokeTerminalFileGrantsForClient(clientId: string): void {
    for (const [id, grant] of this.terminalFileGrants) {
      if (grant.clientId === clientId) {
        this.releaseTerminalFileGrant(id, grant)
      }
    }
  }

  protected releaseTerminalFileGrant(id: string, grant: TerminalFileGrant): void {
    this.terminalFileGrants.delete(id)
    if (grant.expiryTimer) {
      clearTimeout(grant.expiryTimer)
      grant.expiryTimer = undefined
    }
  }

  protected scheduleTerminalFileGrantExpiry(grant: TerminalFileGrant): void {
    if (grant.expiryTimer) {
      clearTimeout(grant.expiryTimer)
    }
    grant.expiryTimer = setTimeout(
      () => {
        if (this.terminalFileGrants.get(grant.id) === grant && grant.expiresAt <= Date.now()) {
          this.releaseTerminalFileGrant(grant.id, grant)
        }
      },
      Math.max(1, grant.expiresAt - Date.now())
    )
    grant.expiryTimer.unref?.()
  }

  async readTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ): Promise<RuntimeFileReadResult> {
    const { grant, target } = await this.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (isMobileBinaryPath(grant.absolutePath)) {
      throw new Error('binary_file')
    }
    let content: string
    if (grant.connectionId) {
      const provider = await this.assertRemoteTerminalFileGrantFreshForRead(grant)
      content = await this.readRemoteTerminalArtifactFile(
        provider,
        grant,
        MOBILE_FILE_READ_MAX_BYTES
      )
    } else {
      const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
      try {
        content = await readLocalTerminalArtifactFileFromHandle(handle, grant)
      } finally {
        await handle.close()
      }
    }
    this.refreshTerminalFileGrant(grant)
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
    const { grant } = await this.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (grant.connectionId) {
      const provider = await this.assertRemoteTerminalFileGrantFreshForRead(grant)
      this.refreshTerminalFileGrant(grant)
      return assertPreviewWithinTransportBudget(
        await this.readRemoteTerminalArtifactPreview(provider, grant, maxContentBytes),
        maxContentBytes
      )
    }
    const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
    try {
      const preview = await readLocalTerminalArtifactPreviewFromHandle(
        handle,
        grant,
        maxContentBytes
      )
      this.refreshTerminalFileGrant(grant)
      return assertPreviewWithinTransportBudget(preview, maxContentBytes)
    } finally {
      await handle.close()
    }
  }
}
