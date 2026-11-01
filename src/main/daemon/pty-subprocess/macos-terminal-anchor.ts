import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HELPER_NAME = 'orca-terminal-anchor'
const ENTRY_NAME = 'terminal-anchor-entry.js'
const ENABLE_ENV_VAR = 'ORCA_TERMINAL_ANCHOR'

export type MacosTerminalAnchorPaths = {
  helper: string
  entry: string
  /** The signed host binary: macOS permission checks follow the anchor's code identity. */
  node: string
}

function defaultPaths(): MacosTerminalAnchorPaths {
  return {
    helper: join(dirname(process.execPath), HELPER_NAME),
    entry: join(dirname(process.argv[1] ?? ''), ENTRY_NAME),
    node: process.execPath
  }
}

/** Off by default: every terminal gains two processes, about 16 MB in all. */
export function wrapPtySpawnInMacosTerminalAnchor(
  file: string,
  args: string[],
  env: Record<string, string | undefined>,
  deps: {
    platform?: NodeJS.Platform
    enabled?: boolean
    paths?: MacosTerminalAnchorPaths
    fileExists?: (path: string) => boolean
  } = {}
): { file: string; args: string[]; anchored: boolean } {
  const enabled = deps.enabled ?? process.env[ENABLE_ENV_VAR] === '1'
  if ((deps.platform ?? process.platform) !== 'darwin' || !enabled) {
    return { file, args, anchored: false }
  }
  const paths = deps.paths ?? defaultPaths()
  const fileExists = deps.fileExists ?? existsSync
  if (!fileExists(paths.helper) || !fileExists(paths.entry)) {
    return { file, args, anchored: false }
  }
  return {
    file: paths.helper,
    args: [
      'launch',
      paths.node,
      paths.entry,
      env.ORCA_WORKTREE_ID ?? '',
      env.ORCA_TERMINAL_HANDLE ?? '',
      file,
      ...args
    ],
    anchored: true
  }
}

/** node-pty names the launcher until the shell takes the foreground. */
export function isMacosTerminalAnchorProcess(processName: string): boolean {
  return processName === HELPER_NAME
}
