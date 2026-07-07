import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { parseCodexSessionContent } from './session-scanner-codex-parser'
import { parseDevinSessionContent } from './session-scanner-devin-parser'
import { parseDroidSessionContent } from './session-scanner-droid-parser'
import { parseMessageGraphSessionContent } from './session-scanner-graph-parsers'
import {
  parseClaudeSessionContent,
  parseGeminiSessionContent
} from './session-scanner-primary-parsers'
import {
  parseCopilotSessionContent,
  parseCursorSessionContent,
  parseHermesSessionContent
} from './session-scanner-secondary-parsers'
import type { FileWithMtime } from './session-scanner-types'
import { normalizeAgentSessionsDir } from './session-scanner-values'
import { remoteCodexIndexTitles } from './remote-session-scanner-codex-index'
import type {
  RemoteParserOptions,
  RemoteScannerContext,
  RemoteSessionSource
} from './remote-session-scanner-types'

type RemoteContentParser = (
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform,
  options: RemoteParserOptions
) => Promise<AiVaultSession | null> | AiVaultSession | null

export function remoteSessionSources(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSource[] {
  return [
    ...remoteCodexSources(remoteHome, hostPlatform),
    jsonlSource(
      'claude',
      remoteHome,
      hostPlatform,
      ['.claude', 'projects'],
      parseClaudeSessionContent
    ),
    source(
      'gemini',
      remoteHome,
      hostPlatform,
      ['.gemini', 'tmp'],
      ['.json', '.jsonl'],
      parseGeminiSessionContent
    ),
    jsonlSource(
      'copilot',
      remoteHome,
      hostPlatform,
      ['.copilot', 'session-state'],
      parseCopilotSessionContent
    ),
    jsonlSource(
      'cursor',
      remoteHome,
      hostPlatform,
      ['.cursor', 'projects'],
      parseCursorSessionContent,
      (path) => remotePathSegments(path).includes('agent-transcripts')
    ),
    source(
      'hermes',
      remoteHome,
      hostPlatform,
      ['.hermes', 'sessions'],
      ['.json'],
      parseHermesSessionContent
    ),
    source(
      'devin',
      remoteHome,
      hostPlatform,
      ['.local', 'share', 'devin', 'cli', 'transcripts'],
      ['.json'],
      parseDevinSessionContent
    ),
    jsonlSource('pi', remoteHome, hostPlatform, remotePiSessionsSegments(), piParser),
    jsonlSource('omp', remoteHome, hostPlatform, remoteOmpSessionsSegments(), ompParser),
    jsonlSource(
      'droid',
      remoteHome,
      hostPlatform,
      ['.factory', 'sessions'],
      parseDroidSessionContent
    ),
    jsonlSource(
      'droid',
      remoteHome,
      hostPlatform,
      ['.factory', 'projects'],
      parseDroidSessionContent
    ),
    ...remoteOpenClawSources(remoteHome, hostPlatform)
  ]
}

function source(
  agent: AiVaultAgent,
  remoteHome: string,
  hostPlatform: RemoteHostPlatform,
  segments: readonly string[],
  extensions: readonly string[],
  parseContent: RemoteContentParser,
  filePredicate?: (path: string) => boolean
): RemoteSessionSource {
  return {
    agent,
    rootDir: joinRemotePath(hostPlatform, remoteHome, ...segments),
    extensions,
    filePredicate,
    parse: (file, content, context) =>
      Promise.resolve(parseContent(file, content, context.hostPlatform.os, parserOptions(context)))
  }
}

function jsonlSource(
  agent: AiVaultAgent,
  remoteHome: string,
  hostPlatform: RemoteHostPlatform,
  segments: readonly string[],
  parseContent: RemoteContentParser,
  filePredicate?: (path: string) => boolean
): RemoteSessionSource {
  return source(agent, remoteHome, hostPlatform, segments, ['.jsonl'], parseContent, filePredicate)
}

function remoteCodexSources(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSource[] {
  return [
    joinRemotePath(hostPlatform, remoteHome, '.codex'),
    joinRemotePath(
      hostPlatform,
      remoteHome,
      '.local',
      'share',
      'orca',
      'codex-runtime-home',
      'home'
    )
  ].map((codexHome) => ({
    agent: 'codex',
    rootDir: joinRemotePath(hostPlatform, codexHome, 'sessions'),
    extensions: ['.jsonl'],
    parse: (file, content, context) =>
      parseCodexSessionContent({
        file,
        content,
        platform: context.hostPlatform.os,
        codexHome,
        executionHostId: context.executionHostId,
        executionHostPlatform: context.hostPlatform.os,
        readIndexedTitle: async (sessionId) =>
          (
            await remoteCodexIndexTitles({
              provider: context.provider,
              codexHome,
              hostPlatform,
              titleCaches: context.titleCaches
            })
          ).get(sessionId) ?? null
      })
  }))
}

function remoteOpenClawSources(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSource[] {
  return ['.openclaw', '.clawdbot'].map((rootName) =>
    jsonlSource(
      'openclaw',
      remoteHome,
      hostPlatform,
      [rootName, 'agents'],
      openClawParser,
      (path) => remotePathSegments(path).includes('sessions')
    )
  )
}

function parserOptions(context: RemoteScannerContext): RemoteParserOptions {
  return {
    executionHostId: context.executionHostId,
    executionHostPlatform: context.hostPlatform.os
  }
}

function piParser(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform,
  options: RemoteParserOptions
): Promise<AiVaultSession | null> {
  return parseMessageGraphSessionContent('pi', file, content, platform, options)
}

function ompParser(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform,
  options: RemoteParserOptions
): Promise<AiVaultSession | null> {
  return parseMessageGraphSessionContent('omp', file, content, platform, options)
}

function openClawParser(
  file: FileWithMtime,
  content: string,
  platform: NodeJS.Platform,
  options: RemoteParserOptions
): Promise<AiVaultSession | null> {
  return parseMessageGraphSessionContent('openclaw', file, content, platform, options)
}

function remotePathSegments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(Boolean)
}

function remotePiSessionsSegments(): string[] {
  return normalizeAgentSessionsDir('/.pi/agent/sessions', '.pi').split('/').filter(Boolean)
}

function remoteOmpSessionsSegments(): string[] {
  return normalizeAgentSessionsDir('/.omp/agent/sessions', '.omp').split('/').filter(Boolean)
}
