import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { isMissingRemoteSessionPathError } from './remote-session-file-stat'
import {
  remoteSessionContentLines,
  streamedSessionContentLines
} from './remote-session-content-lines'
import type {
  RemoteParserOptions,
  RemoteScannerContext,
  RemoteSessionSource
} from './remote-session-scanner-types'
import {
  isKiroSessionMetadataPath,
  kiroTranscriptPathForMetadata,
  parseKiroSessionContent
} from './session-scanner-kiro-parser'
import {
  isKiroV3SessionManifestPath,
  kiroV3SessionDirectoryPredicate,
  kiroV3TranscriptPathForManifest,
  parseKiroV3SessionContent
} from './session-scanner-kiro-v3-parser'
import type { FileWithMtime } from './session-scanner-types'

type KiroSessionContentParser = (
  file: FileWithMtime,
  metadataContent: string,
  transcriptLines: Iterable<string> | AsyncIterable<string> | null,
  platform: NodeJS.Platform,
  options: RemoteParserOptions
) => Promise<AiVaultSession | null>

async function readTranscriptLines(
  transcriptPath: string,
  context: RemoteScannerContext
): Promise<Iterable<string> | AsyncIterable<string> | null> {
  // Why: beside the execution host the transcript streams; megabyte tool outputs are common.
  if (context.provider.readTranscriptBytes) {
    return streamedSessionContentLines(
      context.provider.readTranscriptBytes(transcriptPath, context.signal),
      context.signal
    )
  }
  try {
    throwIfAiVaultScanCancelled(context.signal)
    const read = await context.provider.readFile(transcriptPath)
    throwIfAiVaultScanCancelled(context.signal)
    return read.isBinary ? null : remoteSessionContentLines(read.content, context.signal)
  } catch (error) {
    throwIfAiVaultScanCancelled(context.signal)
    if (isMissingRemoteSessionPathError(error)) {
      return null
    }
    throw error
  }
}

function parseWithTranscript(
  transcriptPathFor: (metadataPath: string) => string,
  parseContent: KiroSessionContentParser
): RemoteSessionSource['parse'] {
  return async (file, content, context) => {
    const options = {
      executionHostId: context.executionHostId,
      executionHostPlatform: context.hostPlatform.os
    }
    try {
      const lines = await readTranscriptLines(transcriptPathFor(file.path), context)
      return await parseContent(file, content, lines, context.hostPlatform.os, options)
    } catch (error) {
      // A transcript that vanished mid-stream leaves a valid metadata-only session.
      if (!isMissingRemoteSessionPathError(error)) {
        throw error
      }
      return parseContent(file, content, null, context.hostPlatform.os, options)
    }
  }
}

export function remoteKiroSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform,
  kiroHomeDir?: string
): RemoteSessionSource {
  return {
    agent: 'kiro',
    rootDir: kiroHomeDir
      ? joinRemotePath(hostPlatform, kiroHomeDir, 'sessions', 'cli')
      : joinRemotePath(hostPlatform, remoteHome, '.kiro', 'sessions', 'cli'),
    extensions: ['.json'],
    filePredicate: isKiroSessionMetadataPath,
    contentDependencyPath: kiroTranscriptPathForMetadata,
    directoryPredicate: () => false,
    parse: parseWithTranscript(kiroTranscriptPathForMetadata, parseKiroSessionContent)
  }
}

/** The V3 engine's store; it ignores KIRO_HOME (kiro-cli 2.27.1), so the root is always home's. */
export function remoteKiroV3Source(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSource {
  return {
    agent: 'kiro',
    rootDir: joinRemotePath(hostPlatform, remoteHome, '.kiro', 'sessions'),
    extensions: ['.json'],
    filePredicate: isKiroV3SessionManifestPath,
    contentDependencyPath: kiroV3TranscriptPathForManifest,
    directoryPredicate: kiroV3SessionDirectoryPredicate,
    parse: parseWithTranscript(kiroV3TranscriptPathForManifest, parseKiroV3SessionContent)
  }
}
