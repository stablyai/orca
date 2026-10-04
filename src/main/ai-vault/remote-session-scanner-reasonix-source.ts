import {
  reasonixSessionLayout,
  isReasonixStorageSessionId
} from '../../shared/reasonix-session-paths'
import { joinRemotePath, remoteDirname, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { RemoteSessionSource } from './remote-session-scanner-types'
import { parseReasonixSessionBytes } from './session-scanner-reasonix-parser'

export function remoteReasonixSource(
  home: string,
  platform: RemoteHostPlatform,
  projectsDir?: string,
  workspaceRoots: readonly string[] = []
): RemoteSessionSource {
  return {
    agent: 'reasonix',
    rootDir: projectsDir ?? joinRemotePath(platform, home, '.reasonix', 'projects'),
    extensions: ['.frames'],
    filePredicate: (path) => reasonixSessionLayout(path) !== null,
    contentDependencyPath: (path) =>
      joinRemotePath(platform, remoteDirname(path, platform), 'manifest.json'),
    directoryPredicate: (name, depth) =>
      depth === 0
        ? !name.startsWith('.')
        : depth === 1
          ? name === 'sessions-v4'
          : depth === 2 && isReasonixStorageSessionId(name),
    readAsBytes: true,
    parseDocument: (file, bytes, context) =>
      parseReasonixSessionBytes(
        file,
        bytes,
        context.provider,
        context.hostPlatform,
        {
          executionHostId: context.executionHostId,
          executionHostPlatform: context.hostPlatform.os,
          reasonixWorkspaceRoots: workspaceRoots
        },
        undefined,
        context.signal
      ),
    parse: async () => {
      throw new Error('Reasonix history must be read as bytes on its execution host')
    }
  }
}
