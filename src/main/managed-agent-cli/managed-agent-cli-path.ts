import { delimiter, dirname, join, resolve } from 'node:path'
import { hasAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/file-access/cross-platform-path'
import {
  cliPathLookup,
  getExecutableNames,
  isQuotedWindowsPathEntry,
  normalizePathEntry
} from '../../shared/shell/command-resolution/node-cli-command-resolution'
import { runCliFsReadsAsync } from '../../shared/shell/command-resolution/cli-fs-reads'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

const pathProgramLookups = new Map<string, Promise<string | null>>()

export function lookUpPathProgram(program: string, pathEnv: string): Promise<string | null> {
  const key = `${program}\0${pathEnv}`
  const pending = pathProgramLookups.get(key)
  if (pending) {
    return pending
  }
  const platform = process.platform
  const lookup = runCliFsReadsAsync(
    cliPathLookup(platform, pathEnv, getExecutableNames(platform, program))
  ).finally(() => pathProgramLookups.delete(key))
  pathProgramLookups.set(key, lookup)
  return lookup
}

export function isOrcaAgentRuntimePath(path: string): boolean {
  return (
    /(?:^|[\\/])agent-runtimes(?:[\\/]|$)/i.test(path) &&
    hasAppEnvironment() &&
    isPathInsideOrEqual(join(getProfileUserDataPath(), 'agent-runtimes'), resolve(path))
  )
}

/** A bare terminal command can hit Orca's runtime before the selected user CLI. */
export async function terminalPathReachesUserProgram(
  program: string,
  file: string,
  pathEnv: string,
  acceptsQuotes: boolean
): Promise<boolean> {
  const folder = normalizeRuntimePathForComparison(dirname(file))
  const earlierRuntimeDirs: string[] = []
  for (const rawEntry of pathEnv.split(delimiter)) {
    if (!acceptsQuotes && isQuotedWindowsPathEntry(rawEntry)) {
      continue
    }
    const entry = normalizePathEntry(process.platform, rawEntry)
    if (!entry) {
      continue
    }
    if (normalizeRuntimePathForComparison(entry) === folder) {
      return (
        earlierRuntimeDirs.length === 0 ||
        (await lookUpPathProgram(program, earlierRuntimeDirs.join(delimiter))) === null
      )
    }
    if (isOrcaAgentRuntimePath(entry)) {
      earlierRuntimeDirs.push(entry)
    }
  }
  return false
}

/** Search the user's PATH without altering the PATH they gave the terminal. */
export function withoutOrcaAgentRuntimeDirectories(pathEnv: string): string {
  return pathEnv
    .split(delimiter)
    .filter((entry) => !isOrcaAgentRuntimePath(normalizePathEntry(process.platform, entry)))
    .join(delimiter)
}
