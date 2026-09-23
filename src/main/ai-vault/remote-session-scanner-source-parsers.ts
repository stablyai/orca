import type { AiVaultSession } from '../../shared/ai-vault-types'
import { parseMessageGraphSessionContent } from './session-scanner-graph-parsers'
import {
  parseMuseSessionContent,
  parseMuseSessionRemoteContent
} from './session-scanner-muse-parser'
import type { FileWithMtime } from './session-scanner-types'
import { normalizeAgentSessionsDir } from './session-scanner-values'
import type { RemoteSessionContent } from './remote-session-content-lines'
import type { RemoteParserOptions } from './remote-session-scanner-types'

export function parseMuseRemoteContent(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform,
  options: RemoteParserOptions,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  if (typeof content === 'string') {
    return Promise.resolve(parseMuseSessionContent(file, content, platform, options))
  }
  return parseMuseSessionRemoteContent(file, content, platform, options, signal)
}

export function piParser(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform,
  options: RemoteParserOptions,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseMessageGraphSessionContent('pi', file, content, platform, options, signal)
}

export function ompParser(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform,
  options: RemoteParserOptions,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseMessageGraphSessionContent('omp', file, content, platform, options, signal)
}

export function primeAgentParser(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform,
  options: RemoteParserOptions,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseMessageGraphSessionContent('prime-agent', file, content, platform, options, signal)
}

export function openClawParser(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform,
  options: RemoteParserOptions,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseMessageGraphSessionContent('openclaw', file, content, platform, options, signal)
}

export function remotePathSegments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(Boolean)
}

export function remotePiSessionsSegments(): string[] {
  return normalizeAgentSessionsDir('/.pi/agent/sessions', '.pi').split('/').filter(Boolean)
}

export function remoteOmpSessionsSegments(): string[] {
  return normalizeAgentSessionsDir('/.omp/agent/sessions', '.omp').split('/').filter(Boolean)
}

// Remote roots are POSIX regardless of the client platform.
export function remotePrimeAgentSessionsSegments(): string[] {
  return ['.prime', 'agent', 'sessions']
}
