import { stat } from 'node:fs/promises'
import { join, relative, type posix } from 'node:path'
import {
  customSlashCommandName,
  dedupeCustomSlashCommands,
  type CustomSlashCommandScope,
  type DiscoveredSlashCommand
} from '../../shared/custom-slash-commands'
import { SKILL_FILE_MAX_DEPTH } from '../../shared/skill-discovery-depth'
import { readMarkdownSummary } from './markdown-summary-read'
import { runSkillCandidateTasks } from './skill-candidate-concurrency'
import { findRootFiles } from './skill-root-file-walk'
import { isSkillRootUnavailableError, SkillScanCoalescer } from './skill-scan-coalescer'

type CommandDiscoveryPathApi = Pick<typeof posix, 'join' | 'relative'>

export type CustomSlashCommandRoot = { path: string; scope: CustomSlashCommandScope }

// Why the same TTL as skill roots: `~/.claude/commands` is one shared tree for
// every open pane, so the fan-out this bounds is identical.
const COMMAND_ROOT_SCAN_TTL_MS = 10_000
const MAX_CACHED_COMMAND_ROOTS = 256

const commandRootScans = new SkillScanCoalescer<DiscoveredSlashCommand[]>(MAX_CACHED_COMMAND_ROOTS)

export function clearCustomSlashCommandScanCache(): void {
  commandRootScans.clear()
}

/** Claude Code reads project commands from the worktree and user commands from
 *  the home profile; both namespace by subdirectory. */
export function buildCustomSlashCommandRoots(args: {
  homeDir: string
  cwd: string
  pathApi?: CommandDiscoveryPathApi
}): CustomSlashCommandRoot[] {
  const pathApi = args.pathApi ?? { join, relative }
  const roots: CustomSlashCommandRoot[] = [
    { path: pathApi.join(args.cwd, '.claude', 'commands'), scope: 'project' },
    { path: pathApi.join(args.homeDir, '.claude', 'commands'), scope: 'user' }
  ]
  // The home directory can be the workspace, and one path must not scan twice.
  return roots.filter((root, index) => roots.findIndex((o) => o.path === root.path) === index)
}

async function scanCommandRoot(
  root: CustomSlashCommandRoot,
  pathApi: CommandDiscoveryPathApi,
  signal: AbortSignal
): Promise<DiscoveredSlashCommand[]> {
  const files = await findRootFiles(
    root.path,
    SKILL_FILE_MAX_DEPTH,
    (fileName) => fileName.toLowerCase().endsWith('.md'),
    signal
  )
  const commands = await runSkillCandidateTasks(
    files.map((commandFilePath) => async (): Promise<DiscoveredSlashCommand | null> => {
      signal.throwIfAborted()
      const name = customSlashCommandName(pathApi.relative(root.path, commandFilePath))
      if (!name) {
        return null
      }
      const summary = await readMarkdownSummary(commandFilePath)
      return {
        name,
        description: summary?.description ?? null,
        scope: root.scope,
        commandFilePath
      }
    })
  )
  return commands.filter((command): command is DiscoveredSlashCommand => command !== null)
}

async function scanCommandRootShared(
  root: CustomSlashCommandRoot,
  pathApi: CommandDiscoveryPathApi,
  refresh: boolean
): Promise<DiscoveredSlashCommand[]> {
  try {
    const outcome = await commandRootScans.run(
      `${root.scope}\0${root.path}`,
      { ttlMs: COMMAND_ROOT_SCAN_TTL_MS, refresh },
      async (signal) => {
        try {
          if (!(await stat(root.path)).isDirectory()) {
            return []
          }
        } catch {
          return []
        }
        return scanCommandRoot(root, pathApi, signal)
      }
    )
    return outcome.value
  } catch (error) {
    if (!isSkillRootUnavailableError(error)) {
      throw error
    }
    // Why degrade: a stalled commands root must not fail the whole discovery and
    // empty a picker whose skills scanned fine.
    return []
  }
}

/** Custom slash commands visible to a Claude Code session rooted at `cwd`. */
export async function discoverCustomSlashCommands(args: {
  homeDir: string
  cwd: string
  refresh?: boolean
  pathApi?: CommandDiscoveryPathApi
}): Promise<DiscoveredSlashCommand[]> {
  const pathApi = args.pathApi ?? { join, relative }
  const roots = buildCustomSlashCommandRoots({
    homeDir: args.homeDir,
    cwd: args.cwd,
    pathApi
  })
  const scans = await Promise.all(
    roots.map((root) => scanCommandRootShared(root, pathApi, args.refresh === true))
  )
  return dedupeCustomSlashCommands(scans.flat())
}
