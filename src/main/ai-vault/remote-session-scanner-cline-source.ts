import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { isMissingRemoteSessionPathError } from './remote-session-file-stat'
import type { RemoteSessionSource } from './remote-session-scanner-types'
import {
  clineMessagesPathForMetadata,
  isClineSessionMetadataPath,
  parseClineSessionContent
} from './session-scanner-cline-parser'

export function remoteClineSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSource {
  return {
    agent: 'cline',
    rootDir: joinRemotePath(hostPlatform, remoteHome, '.cline', 'data', 'sessions'),
    extensions: ['.json'],
    filePredicate: isClineSessionMetadataPath,
    contentDependencyPath: clineMessagesPathForMetadata,
    directoryPredicate: (_name, depth) => depth === 0,
    parse: async (file, content, context) => {
      let messagesContent: string | null = null
      try {
        throwIfAiVaultScanCancelled(context.signal)
        const read = await context.provider.readFile(clineMessagesPathForMetadata(file.path))
        throwIfAiVaultScanCancelled(context.signal)
        messagesContent = read.isBinary ? null : read.content
      } catch (error) {
        throwIfAiVaultScanCancelled(context.signal)
        if (!isMissingRemoteSessionPathError(error)) {
          throw error
        }
      }
      return parseClineSessionContent(file, content, messagesContent, context.hostPlatform.os, {
        executionHostId: context.executionHostId,
        executionHostPlatform: context.hostPlatform.os
      })
    }
  }
}
