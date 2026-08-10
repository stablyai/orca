import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { remoteRolloutIndexTitles } from './remote-session-scanner-rollout-index'
import type { RemoteSessionSource } from './remote-session-scanner-types'
import { parseTraeSessionContent } from './session-scanner-trae-parser'

export function remoteTraeSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSource {
  const sessionHome = joinRemotePath(hostPlatform, remoteHome, '.trae', 'cli')
  return {
    agent: 'trae',
    rootDir: joinRemotePath(hostPlatform, sessionHome, 'sessions'),
    extensions: ['.jsonl'],
    filePredicate: (path) => remoteBasename(path).startsWith('rollout-'),
    directoryPredicate: (name) => !name.endsWith('.artifacts'),
    parse: (file, content, context) =>
      parseTraeSessionContent({
        file,
        content,
        platform: context.hostPlatform.os,
        executionHostId: context.executionHostId,
        executionHostPlatform: context.hostPlatform.os,
        signal: context.signal,
        readIndexedTitle: async (sessionId) =>
          (
            await remoteRolloutIndexTitles({
              provider: context.provider,
              sessionHome,
              hostPlatform: context.hostPlatform,
              titleCaches: context.titleCaches,
              signal: context.signal
            })
          ).get(sessionId) ?? null
      })
  }
}

function remoteBasename(path: string): string {
  return path.replace(/\\/g, '/').split('/').findLast(Boolean) ?? ''
}
