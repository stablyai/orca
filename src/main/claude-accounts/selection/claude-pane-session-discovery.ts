import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { tuiAgentArgsBypassPermissions } from '../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { quoteStartupArg } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { tokenizeCommandLine } from '../../../shared/agent-status/process/agent-command-line-entrypoint'
import { findOptionOccurrence } from '../../../shared/cli/command-option-occurrence'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex
} from '../../../shared/process-observation/tables/process-table-index'
import { listRegisteredPtys } from '../../memory/pty-registry'
import { findClaudeSessionFile } from '../../native-chat/transcript-discovery/session-file-resolver-claude-probe'
import { startedBefore } from '../../providers/foreground/windows/shell-alone-in-job'
import { PROCESS_START_TIME_TOLERANCE_MS } from '../../runtime/agent-session/ownership/agent-session-process-identity-probe'
import { readWindowsProcessTableFresh } from '../../windows/windows-process-table'
import { getClaudeProfileRouter } from '../profiles/routing/claude-profile-installed-router'

export type ClaudeSessionProcessRow = {
  pid: number
  ppid: number
  command: string
  creationTimeMs?: number
}

type SessionRecordMatch = {
  configDir: string
  row: ClaudeSessionProcessRow
  record: Record<string, unknown>
}

const FILETIME_TICKS_PER_MS = 10_000n
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000n

function procStartMs(procStart: unknown): number | null {
  return typeof procStart === 'string' && /^\d{1,20}$/.test(procStart)
    ? Number(BigInt(procStart) / FILETIME_TICKS_PER_MS - FILETIME_UNIX_EPOCH_MS)
    : null
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? Object.fromEntries(Object.entries(parsed))
      : null
  } catch {
    return null
  }
}

function isInteractiveRecordOf(record: Record<string, unknown>, row: ClaudeSessionProcessRow) {
  const startMs = procStartMs(record.procStart)
  return (
    record.pid === row.pid &&
    record.kind === 'interactive' &&
    record.entrypoint === 'cli' &&
    startMs !== null &&
    row.creationTimeMs !== undefined &&
    Math.abs(startMs - row.creationTimeMs) <= PROCESS_START_TIME_TOLERANCE_MS
  )
}

async function findSessionRecords(
  rows: readonly ClaudeSessionProcessRow[],
  configDirs: readonly string[]
): Promise<SessionRecordMatch[]> {
  const listings = await Promise.all(
    configDirs.map(async (configDir) => ({
      configDir,
      names: new Set<string>(await readdir(join(configDir, 'sessions')).catch(() => []))
    }))
  )
  const matches: SessionRecordMatch[] = []
  for (const row of rows) {
    for (const { configDir, names } of listings) {
      const fileName = `${row.pid}.json`
      const record = names.has(fileName)
        ? await readJsonObject(join(configDir, 'sessions', fileName))
        : null
      if (record && isInteractiveRecordOf(record, row)) {
        matches.push({ configDir, row, record })
      }
    }
  }
  return matches
}

function lastFlagValue(argv: readonly string[], flag: string): string | undefined {
  let value: string | undefined
  let found = findOptionOccurrence(argv, [flag], true)
  while (found) {
    value = found.value
    found = findOptionOccurrence(argv, [flag], true, [], found.index + found.consumed)
  }
  return value
}

function launchSettings(command: string): Partial<AgentProviderSessionMetadata> {
  const argv = tokenizeCommandLine(command).slice(1)
  const posixArgs = argv.map((token) => quoteStartupArg(token, 'posix')).join(' ')
  const permissionMode = tuiAgentArgsBypassPermissions('claude', posixArgs, 'posix')
    ? 'bypassPermissions'
    : lastFlagValue(argv, '--permission-mode')
  return {
    effort: lastFlagValue(argv, '--effort'),
    model: lastFlagValue(argv, '--model'),
    permissionMode
  }
}

export async function discoverClaudePaneSession(args: {
  rootPid: number
  rows: readonly ClaudeSessionProcessRow[]
  configDirs: readonly string[]
}): Promise<AgentProviderSessionMetadata | null> {
  const index = buildProcessTableIndex(args.rows)
  const root = index.byPid.get(args.rootPid)
  if (!root) {
    return null
  }
  const descendants = collectDescendantsFromIndex(index, args.rootPid, (row) =>
    startedBefore(row.creationTimeMs, index.byPid.get(row.ppid)?.creationTimeMs)
  )
  const walked = [root, ...descendants]
  if (walked.some((row) => row.creationTimeMs === undefined)) {
    return null
  }
  const matches = await findSessionRecords(walked, args.configDirs)
  const match = matches.length === 1 ? matches[0] : null
  const sessionId = match?.record.sessionId
  if (!match || typeof sessionId !== 'string') {
    return null
  }
  const cwd = typeof match.record.cwd === 'string' ? match.record.cwd : undefined
  const transcriptPath = await findClaudeSessionFile(join(match.configDir, 'projects'), sessionId, {
    cwd
  })
  return transcriptPath
    ? normalizeAgentProviderSession({
        ...launchSettings(match.row.command),
        key: 'session_id',
        id: sessionId,
        transcriptPath,
        cwd
      })
    : null
}

export async function discoverLocalPtyClaudeSession(
  ptyId: string
): Promise<AgentProviderSessionMetadata | null> {
  const rootPid = listRegisteredPtys().find((pty) => pty.ptyId === ptyId)?.pid
  const router = getClaudeProfileRouter()
  // Why Windows only: procStart is decoded as a Windows FILETIME and the table read here is the Windows one.
  if (!rootPid || !router || process.platform !== 'win32') {
    return null
  }
  const rows = await readWindowsProcessTableFresh().catch(() => [])
  return discoverClaudePaneSession({
    rootPid,
    rows,
    configDirs: [...router.accountHomes(), router.systemDefaultHome()]
  })
}
