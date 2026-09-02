// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithRevokeTerminalFileGrantsForClient } from './runtime-file-commands-revoke-terminal-file-grants-for-client'
import type { TerminalFileGrant } from './runtime-file-commands-mobile-file-list-limit'
import {
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  MOBILE_FILE_READ_MAX_BYTES,
  previewableBinaryByteLimit
} from './runtime-file-commands-mobile-file-list-limit'
import { isBinaryBuffer, isMobileBinaryPath } from './runtime-file-command-host'
import {
  assertTerminalFileGrantFresh,
  readFileHandleBufferBounded,
  terminalFileStatIdentity
} from './runtime-file-commands-terminal-artifact-access'
import { openLocalTerminalArtifactGrant } from './runtime-file-commands-terminal-file-paths'
import { chmod, constants, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import type { RuntimeFilePreviewResult } from '../../shared/runtime-types'

export class RuntimeFileCommandsWithWriteTerminalArtifactFile extends RuntimeFileCommandsWithRevokeTerminalFileGrantsForClient {
  async writeTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    content: string,
    clientId?: string
  ): Promise<{ ok: true }> {
    if (Buffer.byteLength(content, 'utf8') > MOBILE_FILE_READ_MAX_BYTES) {
      throw new Error('file_too_large')
    }
    const { grant } = await this.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (grant.readOnly) {
      throw new Error('terminal_file_grant_read_only')
    }
    if (isMobileBinaryPath(grant.absolutePath)) {
      throw new Error('binary_file')
    }
    if (grant.connectionId) {
      const { provider, fileStat } = await this.assertRemoteTerminalFileGrantFresh(grant)
      if (fileStat.type === 'directory') {
        throw new Error('Cannot write to a directory')
      }
      if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
        throw new Error('file_too_large')
      }
      if (!provider.writeTerminalArtifact) {
        throw new Error('terminal_file_grant_unavailable')
      }
      const nextStat = await provider.writeTerminalArtifact(
        grant.absolutePath,
        content,
        this.terminalArtifactAccessOptions(grant, MOBILE_FILE_READ_MAX_BYTES)
      )
      grant.statIdentity = terminalFileStatIdentity(nextStat)
      this.refreshTerminalFileGrant(grant)
      return { ok: true }
    }

    let originalMode: number | null = null
    const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
    try {
      const fileStats = await handle.stat()
      originalMode = fileStats.mode
      if (fileStats.isDirectory()) {
        throw new Error('Cannot write to a directory')
      }
      if (fileStats.size > MOBILE_FILE_READ_MAX_BYTES) {
        throw new Error('file_too_large')
      }
      assertTerminalFileGrantFresh(grant, fileStats)
      if (
        isBinaryBuffer(await readFileHandleBufferBounded(handle, MOBILE_FILE_READ_MAX_BYTES + 1))
      ) {
        throw new Error('binary_file')
      }
    } finally {
      await handle.close()
    }
    const tempPath = join(
      dirname(grant.absolutePath),
      `.${basename(grant.absolutePath)}.${randomUUID()}.tmp`
    )
    try {
      await writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' })
      if (typeof originalMode === 'number') {
        await chmod(tempPath, originalMode & 0o7777)
      }
      const freshHandle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
      try {
        assertTerminalFileGrantFresh(grant, await freshHandle.stat())
      } finally {
        await freshHandle.close()
      }
      await rename(tempPath, grant.absolutePath)
      grant.statIdentity = terminalFileStatIdentity(
        await this.statLocalTerminalPath(grant.absolutePath)
      )
      this.refreshTerminalFileGrant(grant)
      return { ok: true }
    } finally {
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }

  protected async readRemoteTerminalArtifactPreview(
    provider: IFilesystemProvider,
    grant: TerminalFileGrant,
    maxContentBytes: number | undefined
  ): Promise<RuntimeFilePreviewResult> {
    const binaryMaxBytes =
      maxContentBytes === undefined
        ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
        : previewableBinaryByteLimit(maxContentBytes)
    const preview = await this.readRemoteTerminalArtifact(provider, grant, binaryMaxBytes)
    if (
      !preview.isBinary &&
      Buffer.byteLength(preview.content, 'utf8') > MOBILE_FILE_READ_MAX_BYTES
    ) {
      throw new Error('file_too_large')
    }
    if (
      preview.isBinary &&
      maxContentBytes !== undefined &&
      Buffer.byteLength(preview.content, 'utf8') > maxContentBytes
    ) {
      throw new Error('file_too_large')
    }
    return preview
  }

  protected async readRemoteTerminalArtifactFile(
    provider: IFilesystemProvider,
    grant: TerminalFileGrant,
    maxBytes: number
  ): Promise<string> {
    const result = await this.readRemoteTerminalArtifact(provider, grant, maxBytes)
    if (result.isBinary) {
      throw new Error('binary_file')
    }
    return result.content
  }

  protected async readRemoteTerminalArtifact(
    provider: IFilesystemProvider,
    grant: TerminalFileGrant,
    maxBytes: number
  ): Promise<RuntimeFilePreviewResult> {
    if (!provider.readTerminalArtifact) {
      throw new Error('terminal_file_grant_unavailable')
    }
    return provider.readTerminalArtifact(
      grant.absolutePath,
      this.terminalArtifactAccessOptions(grant, maxBytes)
    )
  }

  protected terminalArtifactAccessOptions(
    grant: TerminalFileGrant,
    maxBytes: number
  ): { expectedRealPath: string; expectedStatIdentity: string | null; maxBytes: number } {
    return {
      expectedRealPath: grant.absolutePath,
      expectedStatIdentity: grant.statIdentity,
      maxBytes
    }
  }

  protected async assertRemoteTerminalFileGrantFreshForRead(
    grant: TerminalFileGrant
  ): Promise<IFilesystemProvider> {
    const { provider } = await this.assertRemoteTerminalFileGrantFresh(grant)
    return provider
  }

  protected async assertRemoteTerminalFileGrantFresh(
    grant: TerminalFileGrant
  ): Promise<{ provider: IFilesystemProvider; fileStat: FileStat }> {
    const provider = await this.assertRemoteTerminalFileGrantPathStillCanonical(grant)
    const fileStat = await provider.stat(grant.absolutePath)
    assertTerminalFileGrantFresh(grant, fileStat)
    return { provider, fileStat }
  }
}
