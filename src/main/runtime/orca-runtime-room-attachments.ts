import { extname, posix, win32 } from 'node:path'
import type { RoomAttachment } from '../../shared/rooms'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isENOENT } from '../ipc/filesystem-auth'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { RoomService } from './rooms/service'
import type { RoomDeletionManifest } from './rooms/database'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { OrcaRuntimeWithRoomSessionDiscovery } from './orca-runtime-room-session-discovery'
import { runWslProcess } from '../wsl/wsl-runner'

export abstract class OrcaRuntimeWithRoomAttachments extends OrcaRuntimeWithRoomSessionDiscovery {
  protected abstract roomService: RoomService | null

  async stageRoomAttachment(
    worktreeId: string,
    terminalHandle: string | undefined,
    attachment: Pick<RoomAttachment, 'id' | 'fileName' | 'localPath'>
  ): Promise<string> {
    if (!terminalHandle) {
      return attachment.localPath
    }
    const ptyId = this.getTerminalAgentStatusPtyId(terminalHandle)
    const pty = this.ptysById.get(ptyId)
    if (!pty || !runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId)) {
      throw new Error('terminal_handle_stale')
    }
    const extension = extname(attachment.fileName)
      .slice(0, 20)
      .replace(/[^.\p{L}\p{N}_-]/gu, '_')
    const stableId = attachment.id.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 160)
    if (!stableId) {
      throw new Error('room_attachment_id_invalid')
    }
    if (!pty.connectionId) {
      return pty.wslDistro
        ? this.toWslRoomAttachmentPath(pty.wslDistro, attachment.localPath)
        : attachment.localPath
    }
    const worktree = await this.resolveWorktreeSelector(`id:${worktreeId}`)
    const pathApi = isWindowsAbsolutePathLike(worktree.path) ? win32 : posix
    const orcaDirectory = pathApi.join(worktree.path, '.orca')
    const directory = pathApi.join(orcaDirectory, 'drops')
    const filePath = pathApi.join(directory, `${stableId}${extension}`)
    const provider = getSshFilesystemProvider(pty.connectionId)
    if (!provider) {
      throw new Error('room_attachment_remote_unavailable')
    }
    await provider.createDir(orcaDirectory)
    const gitignorePath = pathApi.join(orcaDirectory, '.gitignore')
    try {
      await provider.stat(gitignorePath)
    } catch (error) {
      if (!isENOENT(error)) {
        throw error
      }
      await provider.writeFile(gitignorePath, '*\n!.gitignore\n')
    }
    await provider.createDir(directory)
    try {
      await provider.stat(filePath)
      this.roomService?.recordAttachmentDrop(attachment.id, pty.connectionId, filePath)
      return filePath
    } catch (error) {
      if (!isENOENT(error)) {
        throw error
      }
    }
    if (!provider.openFileUploadSession) {
      throw new Error('room_attachment_remote_unavailable')
    }
    const upload = await provider.openFileUploadSession()
    try {
      await upload.uploadFile(attachment.localPath, filePath, { exclusive: true })
      this.roomService?.recordAttachmentDrop(attachment.id, pty.connectionId, filePath)
      return filePath
    } catch (error) {
      try {
        await provider.stat(filePath)
        this.roomService?.recordAttachmentDrop(attachment.id, pty.connectionId, filePath)
        return filePath
      } catch {
        throw error
      }
    } finally {
      upload.close()
    }
  }

  async cleanupDeletedRoomResources(manifest: RoomDeletionManifest): Promise<void> {
    await Promise.all(
      manifest.drops.map(async ({ connectionId, remotePath }) => {
        const provider = getSshFilesystemProvider(connectionId)
        if (!provider) {
          throw new Error('room_attachment_remote_unavailable')
        }
        try {
          await provider.deletePath(remotePath)
        } catch (error) {
          if (!isENOENT(error)) {
            throw error
          }
        }
      })
    )
  }

  private async toWslRoomAttachmentPath(distro: string, localPath: string): Promise<string> {
    const result = await runWslProcess({
      distro,
      loginPath: 'none',
      program: 'wslpath',
      args: ['-a', '-u', localPath],
      timeoutMs: 10_000
    })
    const converted = result.stdout.trim()
    if (result.timedOut || result.code !== 0 || !converted) {
      throw new Error(result.stderr.trim() || 'room_attachment_wsl_path_invalid')
    }
    return converted
  }
}
