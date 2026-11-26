import { delimiter, join, resolve } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import { normalizePathEntry } from '../../shared/shell/command-resolution/node-cli-command-resolution'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

export function isOrcaAgentRuntimePath(path: string): boolean {
  return (
    /(?:^|[\\/])agent-runtimes(?:[\\/]|$)/i.test(path) &&
    isPathInsideOrEqual(join(getProfileUserDataPath(), 'agent-runtimes'), resolve(path))
  )
}

/** Search the user's PATH without altering the PATH they gave the terminal. */
export function withoutOrcaAgentRuntimeDirectories(pathEnv: string): string {
  return pathEnv
    .split(delimiter)
    .filter((entry) => !isOrcaAgentRuntimePath(normalizePathEntry(process.platform, entry)))
    .join(delimiter)
}
