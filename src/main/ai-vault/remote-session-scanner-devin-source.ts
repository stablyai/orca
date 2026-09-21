import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { remoteSessionDocumentParsers } from './remote-session-document-parsers'
import type { RemoteSessionSource } from './remote-session-scanner-types'
import { parseDevinSessionContent } from './session-scanner-devin-parser'

// Why: Devin CLI writes transcripts under %APPDATA% on a Windows host and
// ~/.local/share on posix ones.
function remoteDevinDataSegments(hostPlatform: RemoteHostPlatform): string[] {
  return hostPlatform.os === 'win32'
    ? ['AppData', 'Roaming', 'devin', 'cli']
    : ['.local', 'share', 'devin', 'cli']
}

export function remoteDevinSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform,
  directory: 'transcripts' | 'agent_logs' = 'transcripts'
): RemoteSessionSource {
  return {
    agent: 'devin',
    rootDir: joinRemotePath(
      hostPlatform,
      remoteHome,
      ...remoteDevinDataSegments(hostPlatform),
      directory
    ),
    extensions: ['.json'],
    ...remoteSessionDocumentParsers('devin'),
    parse: (file, content, context) =>
      Promise.resolve(
        parseDevinSessionContent(file, content, context.hostPlatform.os, {
          executionHostId: context.executionHostId,
          executionHostPlatform: context.hostPlatform.os
        })
      )
  }
}
