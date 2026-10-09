import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { parseCodexSessionContent } from './session-scanner-codex-parser'
import { remoteCodexIndexedTitleReader } from './remote-session-scanner-codex-index'
import type { RemoteSessionContent } from './remote-session-content-lines'
import type { FileWithMtime } from './session-scanner-types'
import type { RemoteScannerContext, RemoteSessionSource } from './remote-session-scanner-types'

/** Codex is the one remote agent whose sessions live under two CODEX_HOME roots, so it
 *  yields a source per root. Split from `remote-session-scanner-sources.ts` so adding an
 *  agent does not push that module past its line budget. */
export function remoteCodexSources(
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
  ].flatMap((codexHome) => {
    const parse = (
      file: FileWithMtime,
      content: RemoteSessionContent,
      context: RemoteScannerContext
    ) =>
      parseCodexSessionContent({
        file,
        content,
        platform: context.hostPlatform.os,
        codexHome,
        executionHostId: context.executionHostId,
        executionHostPlatform: context.hostPlatform.os,
        signal: context.signal,
        readIndexedTitle: remoteCodexIndexedTitleReader(codexHome, context)
      })
    // Why: the Codex App and `codex resume --archive` move finished rollouts into
    // archived_sessions; both dirs use the same rollout format and index.
    return (['sessions', 'archived_sessions'] as const).map((historyDirName) => ({
      agent: 'codex' as const,
      rootDir: joinRemotePath(hostPlatform, codexHome, historyDirName),
      codexHome,
      extensions: ['.jsonl'],
      parse,
      parseLines: parse
    }))
  })
}
