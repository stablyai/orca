import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  createCursorSessionMetadataResolver,
  type CursorSessionMetadataResolver
} from './session-scanner-cursor-metadata'
import { parseCursorSessionContent } from './session-scanner-cursor-parser'
import type {
  RemoteSessionFilesystemProvider,
  RemoteSessionSource
} from './remote-session-scanner-types'

export function createRemoteCursorSessionMetadataResolver(args: {
  provider: RemoteSessionFilesystemProvider
  hostPlatform: RemoteHostPlatform
  signal?: AbortSignal
}): CursorSessionMetadataResolver {
  return createCursorSessionMetadataResolver({
    listDirectories: async (path) => {
      try {
        throwIfAiVaultScanCancelled(args.signal)
        const entries = await args.provider.readDir(path)
        throwIfAiVaultScanCancelled(args.signal)
        return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name)
      } catch {
        throwIfAiVaultScanCancelled(args.signal)
        return []
      }
    },
    readTextFile: async (path) => {
      try {
        throwIfAiVaultScanCancelled(args.signal)
        const read = await args.provider.readFile(path)
        throwIfAiVaultScanCancelled(args.signal)
        return read.isBinary ? null : read.content
      } catch {
        throwIfAiVaultScanCancelled(args.signal)
        return null
      }
    },
    joinPath: (...segments) =>
      joinRemotePath(args.hostPlatform, segments[0] ?? '', ...segments.slice(1))
  })
}

export function remoteCursorSessionSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSource {
  const chatsDir = joinRemotePath(hostPlatform, remoteHome, '.cursor', 'chats')
  return {
    agent: 'cursor',
    rootDir: joinRemotePath(hostPlatform, remoteHome, '.cursor', 'projects'),
    extensions: ['.jsonl'],
    filePredicate: (path) => path.replace(/\\/g, '/').split('/').includes('agent-transcripts'),
    parse: async (file, content, context) => {
      const session = await parseCursorSessionContent(
        file,
        content,
        context.hostPlatform.os,
        {
          executionHostId: context.executionHostId,
          executionHostPlatform: context.hostPlatform.os
        },
        context.signal
      )
      return session
        ? context.cursorMetadataResolver.enrich(session, chatsDir, context.hostPlatform.os)
        : null
    }
  }
}
