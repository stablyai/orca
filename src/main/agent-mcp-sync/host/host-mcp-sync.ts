import { chmod, mkdir, readFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AgentMcpSyncParams,
  AgentMcpSyncResult,
  McpSyncHostOutcome
} from '../../../shared/agent-mcp-sync/mcp-sync-contract'
import { errnoCodeOrUnknown } from '../../../shared/errno-code'
import { writeFileAtomicallyIfUnchanged } from '../../filesystem/atomic-file-publication'
import { isCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'
import { hostShellEnvironment } from '../../runtime/agent-session/environment/structured-agent-shell-environment'
import { mergeClaudeMcpServers } from './claude-json-mcp-merge'
import { codexMcpBlockMarkers, mergeCodexMcpServers } from './codex-toml-mcp-merge'
import { EMPTY_MCP_SYNC_LEDGER, parseMcpSyncLedger, type McpSyncLedger } from './mcp-sync-ledger'

// Agent configs carry MCP env tokens and headers; keep them owner-only.
const PRIVATE_FILE = { mode: 0o600 } as const
const DNS_TIMEOUT_MS = 3_000
// The agent CLIs rewrite ~/.claude.json often; retry a lost race instead of clobbering their write.
const WRITE_ATTEMPTS = 4

export type HostMcpSyncPaths = {
  claudeConfig: string
  codexConfig: string
  ledger: string
}

export type HostMcpSyncDeps = {
  paths: HostMcpSyncPaths
  /** The host workspace's project root (Claude project scope key); Orca Cloud sets ORCA_WORKSPACE_PATH. */
  projectPath?: string | null
  commandExists?: (command: string) => Promise<boolean>
  resolves?: (hostname: string) => Promise<boolean>
}

export function syncerLedgerPath(sharedLedger: string, syncer: string): string {
  return sharedLedger.replace(/\.json$/, `-${syncer}.json`)
}

export function defaultHostMcpSyncPaths(userDataPath: string): HostMcpSyncPaths {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim()
  return {
    claudeConfig: claudeDir ? join(claudeDir, '.claude.json') : join(homedir(), '.claude.json'),
    codexConfig: join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'config.toml'),
    ledger: join(userDataPath, 'mcp-sync-ledger.json')
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function writePrivate(path: string, expected: string | null, text: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  if (!writeFileAtomicallyIfUnchanged(path, expected, text, PRIVATE_FILE)) {
    return false
  }
  // The guarded publish keeps the temp file's mode, but tighten an inherited looser one anyway.
  await chmod(path, PRIVATE_FILE.mode)
  return true
}

/** Same lookup and login-shell environment Orca uses to find agent CLIs, so the answer matches
 * what an agent launched here would see. */
export async function defaultCommandExists(command: string): Promise<boolean> {
  const shellEnv = await hostShellEnvironment().catch(() => process.env)
  return (
    (await isCommandOnLocalPath(command, { env: shellEnv })) ||
    (await isCommandOnLocalPath(command))
  )
}

async function defaultResolves(hostname: string): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), DNS_TIMEOUT_MS).unref?.()
  })
  return Promise.race([
    lookup(hostname).then(
      () => true,
      () => false
    ),
    timeout
  ])
}

/** Drop stdio servers whose command this host cannot run, so no broken entry gets written. */
async function runnable(
  servers: Readonly<Record<string, Record<string, unknown>>>,
  commandExists: (command: string) => Promise<boolean>,
  outcomes: Record<string, McpSyncHostOutcome>
): Promise<Record<string, Record<string, unknown>>> {
  const kept: Record<string, Record<string, unknown>> = {}
  for (const [name, config] of Object.entries(servers)) {
    const command = typeof config.command === 'string' ? config.command : null
    if (command && typeof config.url !== 'string' && !(await commandExists(command))) {
      outcomes[name] = 'command-missing'
      continue
    }
    kept[name] = config
  }
  return kept
}

function remoteHostnames(params: AgentMcpSyncParams): string[] {
  const names = new Set<string>()
  for (const servers of [params.claude, params.codex]) {
    for (const config of Object.values(servers ?? {})) {
      if (typeof config.url === 'string') {
        try {
          names.add(new URL(config.url).hostname)
        } catch {
          // The desktop only sends valid URLs; ignore anything else.
        }
      }
    }
  }
  return [...names]
}

function unreadable(
  servers: Readonly<Record<string, unknown>>
): Record<string, McpSyncHostOutcome> {
  return Object.fromEntries(Object.keys(servers).map((name) => [name, 'config-unreadable']))
}

async function syncClaude(
  paths: HostMcpSyncPaths,
  desired: Record<string, Record<string, unknown>>,
  ledger: McpSyncLedger,
  projectPath?: string
): Promise<Record<string, McpSyncHostOutcome>> {
  const scopeLedger = (projectPath ? ledger.claudeProject : ledger.claude) ?? {}
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const text = await readText(paths.claudeConfig)
    let merged: ReturnType<typeof mergeClaudeMcpServers>
    try {
      merged = mergeClaudeMcpServers(text, desired, scopeLedger, projectPath)
    } catch {
      return unreadable(desired)
    }
    if (merged.text === null || (await writePrivate(paths.claudeConfig, text, merged.text))) {
      if (projectPath) {
        ledger.claudeProject = merged.ledger
      } else {
        ledger.claude = merged.ledger
      }
      return merged.outcomes
    }
  }
  return unreadable(desired)
}

async function syncCodex(
  paths: HostMcpSyncPaths,
  desired: Record<string, Record<string, unknown>>,
  ledger: McpSyncLedger,
  syncer: string | undefined,
  adoptLegacy: boolean
): Promise<Record<string, McpSyncHostOutcome>> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const text = await readText(paths.codexConfig)
    let merged: ReturnType<typeof mergeCodexMcpServers>
    try {
      merged = mergeCodexMcpServers(
        text,
        desired,
        ledger.codexBlock,
        codexMcpBlockMarkers(syncer),
        adoptLegacy ? codexMcpBlockMarkers(undefined) : undefined
      )
    } catch {
      return unreadable(desired)
    }
    if (merged.text === null || (await writePrivate(paths.codexConfig, text, merged.text))) {
      ledger.codexBlock = merged.blockPrint
      return merged.outcomes
    }
  }
  return unreadable(desired)
}

/** Apply the desktop's MCP servers to this host's agent configs. Logs counts only, never values. */
export async function syncHostMcpServers(
  params: AgentMcpSyncParams,
  deps: HostMcpSyncDeps
): Promise<AgentMcpSyncResult> {
  const commandExists = deps.commandExists ?? defaultCommandExists
  const resolves = deps.resolves ?? defaultResolves
  // Each syncing computer has its own ledger: entries another computer wrote are not this one's to
  // remove (they read as the host's own), so two computers on one shared sandbox never flap.
  const ledgerPath = params.syncer
    ? syncerLedgerPath(deps.paths.ledger, params.syncer)
    : deps.paths.ledger
  const ownText = await readText(ledgerPath)
  // The first computer to sync after per-computer ledgers takes over what the shared ledger recorded.
  const legacyText = params.syncer && ownText === null ? await readText(deps.paths.ledger) : null
  const adoptLegacy = legacyText !== null
  const ledgerText = ownText
  const ledger = parseMcpSyncLedger(ownText ?? legacyText)
  const result: AgentMcpSyncResult = {}
  if (params.claude) {
    const outcomes: Record<string, McpSyncHostOutcome> = {}
    const desired = await runnable(params.claude, commandExists, outcomes)
    result.claude = { ...outcomes, ...(await syncClaude(deps.paths, desired, ledger)) }
  }
  // Project scope: named alongside user scope means "this complete set" (empty when omitted), so
  // project servers removed on the desktop leave the host too.
  if (
    params.claudeProject ||
    (params.claude && Object.keys(ledger.claudeProject ?? {}).length > 0)
  ) {
    const outcomes: Record<string, McpSyncHostOutcome> = {}
    const desired = await runnable(params.claudeProject ?? {}, commandExists, outcomes)
    const projectPath = deps.projectPath ?? null
    const project = projectPath
      ? await syncClaude(deps.paths, desired, ledger, projectPath)
      : // No workspace project on this host: never widen project servers to user scope.
        unreadable(desired)
    result.claude = { ...result.claude, ...outcomes, ...project }
  }
  if (params.codex) {
    const outcomes: Record<string, McpSyncHostOutcome> = {}
    const desired = await runnable(params.codex, commandExists, outcomes)
    result.codex = {
      ...outcomes,
      ...(await syncCodex(deps.paths, desired, ledger, params.syncer, adoptLegacy))
    }
  }
  const nextLedger = `${JSON.stringify(ledger, null, 2)}\n`
  if (nextLedger !== ledgerText) {
    await writePrivate(ledgerPath, ledgerText, nextLedger)
  }
  if (adoptLegacy) {
    // Claimed: a second computer must not adopt the same entries.
    await writePrivate(
      deps.paths.ledger,
      legacyText,
      `${JSON.stringify(EMPTY_MCP_SYNC_LEDGER, null, 2)}\n`
    )
  }
  const hostnames = remoteHostnames(params)
  const reachable = await Promise.all(hostnames.map(resolves))
  const unreachableHosts = hostnames.filter((_, index) => !reachable[index])
  if (unreachableHosts.length > 0) {
    result.unreachableHosts = unreachableHosts
  }
  const count = (outcomes?: Record<string, McpSyncHostOutcome>): string =>
    Object.entries(
      Object.values(outcomes ?? {}).reduce<Record<string, number>>((acc, outcome) => {
        acc[outcome] = (acc[outcome] ?? 0) + 1
        return acc
      }, {})
    )
      .map(([outcome, n]) => `${outcome}=${n}`)
      .join(',')
  console.info(
    `[mcp-sync] claude{${count(result.claude)}} codex{${count(result.codex)}} unresolved=${unreachableHosts.length}`
  )
  return result
}
