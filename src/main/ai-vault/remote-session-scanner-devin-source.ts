import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { remoteSessionDocumentParsers } from './remote-session-document-parsers'
import type { RemoteSessionSource } from './remote-session-scanner-types'
import { parseDevinSessionContent } from './session-scanner-devin-parser'

// Why: Devin CLI writes transcripts under %APPDATA% on a Windows host and
// ~/.local/share on posix ones.
function remoteDevinTranscriptsSegments(hostPlatform: RemoteHostPlatform): string[] {
  return hostPlatform.os === 'win32'
    ? ['AppData', 'Roaming', 'devin', 'cli', 'transcripts']
    : ['.local', 'share', 'devin', 'cli', 'transcripts']
}

export function remoteDevinSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSource {
  return {
    agent: 'devin',
    rootDir: joinRemotePath(
      hostPlatform,
      remoteHome,
      ...remoteDevinTranscriptsSegments(hostPlatform)
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
