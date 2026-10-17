import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import type { DebugSettings } from '../../shared/debug-settings-types'
import type { Repo } from '../../shared/repo-types'
import { isWslUncPath } from '../../shared/wsl-paths'
import type * as Wire from '../../preload/api/debug-api'
import {
  DAP_ADAPTERS,
  resolveDebugAdapter,
  type DapAdapterRow,
  type DapResolveOptions,
  type ResolvedDebugAdapter
} from './dap-adapter-registry'
import * as bps from './debug-breakpoint-store'
import { OutputRing } from './dap-protocol'
import { DEBUG_OUTPUT_RING_ENTRIES, DebugSession } from './debug-session'
import { DebugServiceError } from './debug-breakpoint-store'
import { listLaunchConfigs, resolveLaunchSpec, type LaunchSpec } from './launch-config'

export { DebugServiceError }
export type DebugOrigin = 'ui' | 'cli'
export type DebugStartInput = Wire.DebugLaunchTarget & {
  expectedHash?: string
  origin: DebugOrigin
}

export type DebugTrustDeps = {
  getSettings: () => DebugSettings
  getRepo: (repoId: string) => Repo | undefined
  /** Every worktree/folder root of the repo; a session root must be one of these. */
  listRepoRoots: (repo: Repo) => Promise<string[]>
  updateSettings: (updates: Partial<DebugSettings>) => void
  platform?: NodeJS.Platform
  /** Tests inject a fake adapter; production resolves the registry row. */
  resolveAdapter?: (row: DapAdapterRow, options: DapResolveOptions) => Promise<ResolvedDebugAdapter>
  table?: readonly DapAdapterRow[]
  /** The key a HumanConfirmation must carry; only debug-handlers.ts holds it. */
  humanKey: symbol
}

/** Every method of a service that was never configured, as in the headless orcad boot. */
export class DebugUnavailableError extends DebugServiceError {
  constructor() {
    super('debug_unavailable', 'The debugger is not available in this process.')
    this.name = 'DebugUnavailableError'
  }
}

export function refuse(reason: Wire.DebugRefusalReason, message: string): Wire.DebugRefusal {
  return { ok: false, reason, message }
}

/**
 * Proof a person confirmed in Orca's window: keyed by a symbol only debug-handlers.ts holds and
 * hands to configure(), so an RPC or CLI path can never construct one.
 */
export type HumanConfirmation = Readonly<Record<symbol, true>>

/** What preview shows and approve/start re-check: the launch config AND the adapter it runs. */
export function launchExpectedHash(configHash: string, approvalKey: string): string {
  return createHash('sha256').update(`${configHash}\n${approvalKey}`).digest('hex')
}

/** cli may read a person's session but never run code in it or drive it. */
export function humanSessionRefusal(origin: DebugOrigin, sessionOrigin: DebugOrigin | null) {
  const message = 'A person started this debug session; agents may only read it.'
  return origin === 'cli' && sessionOrigin !== 'cli'
    ? new DebugServiceError('human-session', message)
    : null
}

/** Why refuse: an adapter spawned here cannot debug a program on another host or in WSL by path. */
export function getDebugHostRefusal(
  repo: Repo,
  rootPath: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  // An allowlist: a host kind added later stays refused until it is shown to be local.
  const host: string | null | undefined = repo.executionHostId
  if (repo.connectionId || host?.startsWith('ssh:')) {
    return 'Debugging is not supported for SSH workspaces.'
  }
  if (host !== undefined && host !== null && host !== 'local') {
    return 'Debugging is not supported for workspaces on a remote Orca runtime.'
  }
  if (platform === 'win32' && isWslUncPath(rootPath)) {
    return 'Debugging is not supported for WSL workspaces.'
  }
  return null
}

/** The root is derived in main from the repo, never trusted from the caller. */
export async function resolveTrustedRoot(
  deps: DebugTrustDeps,
  repoId: string,
  worktreePath: string,
  requireEnabled: boolean
): Promise<{ ok: true; root: string } | Wire.DebugRefusal> {
  const repo = deps.getRepo(repoId)
  if (!repo) {
    return refuse('unknown-repo', `No repo ${repoId}`)
  }
  const root = bps.normalizeDebugPath(worktreePath)
  // Spec order: a path outside the repo's roots is refused before the host is judged.
  const roots = (await deps.listRepoRoots(repo)).map(bps.normalizeDebugPath)
  if (!roots.includes(root)) {
    return refuse('outside-worktree', `${worktreePath} is not a worktree of this repo`)
  }
  const hostRefusal = getDebugHostRefusal(repo, root, deps.platform)
  if (hostRefusal) {
    return refuse('remote-workspace', hostRefusal)
  }
  if (requireEnabled && !deps.getSettings().debugEnabledRepos.includes(repoId)) {
    return refuse('repo-not-enabled', 'Debugging is not enabled for this repo in Settings.')
  }
  return { ok: true, root }
}

export type TrustedLaunch = {
  ok: true
  repoId: string
  root: string
  spec: LaunchSpec
  row: DapAdapterRow
  /** What to spawn: binaryPath + spawnArgs, under approvalKey. */
  adapter: Extract<ResolvedDebugAdapter, { ok: true }>
  preview: Wire.DebugLaunchPreview
}

function approvalsOf(settings: DebugSettings, repoId: string, approvalKey: string, hash: string) {
  return {
    repo: settings.debugEnabledRepos.includes(repoId),
    adapter: (settings.debugAdapterApprovals[repoId] ?? []).includes(approvalKey),
    launch: (settings.debugLaunchApprovals[repoId] ?? []).includes(hash)
  }
}

/** Re-reads launch.json and re-resolves the adapter from disk on every call (TOCTOU-safe). */
export async function resolveTrustedLaunch(
  deps: DebugTrustDeps,
  target: Wire.DebugLaunchTarget,
  requireEnabled: boolean
): Promise<TrustedLaunch | Wire.DebugRefusal> {
  const trusted = await resolveTrustedRoot(deps, target.repoId, target.worktreePath, requireEnabled)
  if (!trusted.ok) {
    return trusted
  }
  const { root } = trusted
  const filePath = target.filePath ? bps.normalizeDebugPath(target.filePath) : undefined
  if (filePath && !bps.isInsideRoot(root, filePath)) {
    return refuse('outside-worktree', `${target.filePath} is outside the worktree`)
  }
  const table = deps.table ?? DAP_ADAPTERS
  const settings = deps.getSettings()
  const { configName, lineNumber, languageId } = target
  const input = { worktreePath: root, configName, filePath, lineNumber, languageId, table }
  const resolved = await resolveLaunchSpec({ ...input, adapterOptions: { settings } })
  if (!resolved.ok) {
    return refuse(resolved.reason, resolved.message)
  }
  const { spec } = resolved
  const row = table.find((r) => r.id === spec.adapterId)
  if (!row) {
    return refuse('unknown-type', `No debug adapter "${spec.adapterId}"`)
  }
  const pythonOverride = typeof spec.config.python === 'string' ? spec.config.python : undefined
  const resolve = deps.resolveAdapter ?? resolveDebugAdapter
  // Approved keys let the registry probe an approved python for debugpy, and only an approved one.
  const approvedKeys = settings.debugAdapterApprovals[target.repoId] ?? []
  const adapter = await resolve(row, { settings, worktreePath: root, pythonOverride, approvedKeys })
  if (!adapter.ok) {
    return refuse('adapter-not-found', adapter.hint)
  }
  const { binaryPath, args, approvalKey, repoLocal } = adapter
  const preview: Wire.DebugLaunchPreview = {
    name: spec.name,
    configHash: spec.configHash,
    expectedHash: launchExpectedHash(spec.configHash, approvalKey),
    runs: spec.runs,
    ...(spec.consoleForcedFrom ? { consoleForcedFrom: spec.consoleForcedFrom } : {}),
    adapter: { id: row.id, binaryPath, args, approvalKey, repoLocal },
    approved: approvalsOf(settings, target.repoId, approvalKey, spec.configHash)
  }
  return { ok: true, repoId: target.repoId, root, spec, row, adapter, preview }
}

/** The ordered gate: trusted launch, unchanged since preview, then (for a start) both approvals. */
export async function gateLaunch(
  deps: DebugTrustDeps,
  target: Wire.DebugLaunchTarget & { expectedHash?: string },
  origin: DebugOrigin | 'approve'
): Promise<TrustedLaunch | Wire.DebugRefusal> {
  const launch = await resolveTrustedLaunch(deps, target, true)
  if (!launch.ok) {
    return launch
  }
  const { name } = launch.spec
  // A swapped .venv/bin/python changes the adapter key, and so this hash, as much as a launch.json edit.
  if (target.expectedHash !== undefined && launch.preview.expectedHash !== target.expectedHash) {
    return refuse('changed-since-preview', `"${name}" changed since it was previewed.`)
  }
  if (origin === 'approve') {
    return launch
  }
  if (!launch.preview.approved.adapter) {
    const message = `${launch.adapter.binaryPath} is not approved to debug this repo.`
    return refuse('adapter-not-approved', message)
  }
  if (!launch.preview.approved.launch) {
    // An agent (origin cli) can run only what a person confirmed through approveLaunch.
    const message =
      origin === 'cli'
        ? `"${name}" was never approved in Orca's debugger; a person must start it first.`
        : `"${name}" needs confirming before it runs.`
    return refuse('launch-not-approved', message)
  }
  return launch
}

/** Recomputes from disk; stores the adapter key and config hash main computed, only on a match. */
export async function approveTrustedLaunch(
  deps: DebugTrustDeps,
  target: Wire.DebugLaunchTarget & { expectedHash: string },
  confirmation: HumanConfirmation | undefined
): Promise<Wire.DebugResult<Wire.DebugLaunchPreview>> {
  if (confirmation?.[deps.humanKey] !== true) {
    return refuse('human-confirmation-required', 'Only a person in Orca can approve a launch.')
  }
  const launch = await gateLaunch(deps, target, 'approve')
  if (!launch.ok) {
    return launch
  }
  const settings = deps.getSettings()
  const add = (table: Record<string, string[]>, value: string): Record<string, string[]> => {
    const current = table[launch.repoId] ?? []
    return current.includes(value) ? table : { ...table, [launch.repoId]: [...current, value] }
  }
  deps.updateSettings({
    debugAdapterApprovals: add(settings.debugAdapterApprovals, launch.adapter.approvalKey),
    debugLaunchApprovals: add(settings.debugLaunchApprovals, launch.spec.configHash)
  })
  const approved = { repo: true, adapter: true, launch: true }
  return { ok: true, value: { ...launch.preview, approved } }
}

/** Lists launch.json only for a root main derived from the repo. */
export async function listTrustedConfigs(
  deps: DebugTrustDeps,
  repoId: string,
  worktreePath: string
) {
  const trusted = await resolveTrustedRoot(deps, repoId, worktreePath, false)
  const listed = trusted.ok ? await listLaunchConfigs(trusted.root, deps.table) : trusted
  return listed.ok
    ? { ok: true as const, value: listed.configs }
    : refuse(listed.reason, listed.message)
}

export async function previewTrustedLaunch(
  deps: DebugTrustDeps,
  target: Wire.DebugLaunchTarget
): Promise<Wire.DebugResult<Wire.DebugLaunchPreview>> {
  const launch = await resolveTrustedLaunch(deps, target, false)
  return launch.ok ? { ok: true, value: launch.preview } : launch
}

/** Restart reuses the running spec, so it re-checks that trust was not revoked meanwhile. */
export function restartRefusal(settings: DebugSettings, launch: TrustedLaunch | null) {
  const approved = launch
    ? approvalsOf(settings, launch.repoId, launch.adapter.approvalKey, launch.spec.configHash)
    : null
  return approved?.repo && approved.adapter && approved.launch
    ? null
    : refuse('launch-not-approved', 'Debugging approval for this launch was revoked.')
}

/** Spawns exactly the approved binary and args; cwd outside the worktree so `python -m` cannot load repo modules. */
export function createTrustedSession(
  launch: TrustedLaunch,
  breakpoints: bps.DebugBreakpointStore,
  exceptionFilters: string[] | undefined
): DebugSession {
  const { adapter, root, spec, row } = launch
  const command = { program: adapter.binaryPath, args: adapter.spawnArgs, cwd: homedir() }
  return new DebugSession({ spec, command, worktreeRoot: root, breakpoints, row, exceptionFilters })
}

/** What a caller that may not drive the session can still do. */
export type DebugSessionReader = Pick<
  DebugSession,
  'threads' | 'stackTrace' | 'scopes' | 'variables'
>
type Event = Wire.DebugOutputEvent | Wire.DebugStateEvent

/** One worktree's session, its origin, its sequenced event ring and the waiters on its next state. */
export class WorktreeDebug {
  seq = 0
  session: DebugSession | null = null
  origin: DebugOrigin | null = null
  launch: TrustedLaunch | null = null
  lastError: string | null = null
  /** Seq of the last cli start, restart, continue, step or pause: where a cli wait counts from. */
  cliControlSeq: number | null = null
  threads: Wire.DebugThreadWire[] = []
  exceptionFilters: string[] | undefined
  /** Seq of the newest event evicted from the ring. */
  evictedThrough = 0
  readonly ring = new OutputRing<Event>(
    DEBUG_OUTPUT_RING_ENTRIES,
    (e) => ('text' in e ? Buffer.byteLength(e.text) : 16),
    (e) => (this.evictedThrough = e.seq)
  )
  outputTotal = 0
  answers = ''
  timer: ReturnType<typeof setInterval> | null = null
  release: ReturnType<typeof setTimeout> | null = null
  readonly waiters = new Set<{
    statuses: readonly Wire.DebugStatus[]
    finish: (timedOut: boolean) => void
  }>()

  constructor(readonly root: string) {}

  get live(): boolean {
    return ['starting', 'running', 'stopped'].includes(this.session?.state.status ?? 'idle')
  }

  /** A state in `statuses` happened after `since`; past the ring's reach, the current state decides. */
  reachedSince(since: number, statuses: readonly Wire.DebugStatus[]): boolean {
    const now = this.session?.state.status ?? 'idle'
    const states = this.ring.all().filter((e): e is Wire.DebugStateEvent => 'kind' in e)
    const seen = states.some((e) => e.seq > since && statuses.includes(e.status))
    return seen || (since < this.evictedThrough && statuses.includes(now))
  }

  /** The session; with an origin, refuses a cli caller in a session a person started. */
  requireSession(requireLive: boolean, origin?: DebugOrigin): DebugSession {
    if (!this.session || (requireLive && !this.live)) {
      throw new DebugServiceError('no-session', `No debug session for ${this.root}`)
    }
    const human = origin && humanSessionRefusal(origin, this.origin)
    if (human) {
      throw human
    }
    return this.session
  }

  /** Conditions, hit conditions and log messages run as code: cli sets them only in its own live session. */
  allowCodeFields(fields: Wire.DebugBreakpointFields, origin: DebugOrigin): void {
    const human = humanSessionRefusal(origin, this.live ? this.origin : null)
    if (human && (fields.condition || fields.hitCondition || fields.logMessage)) {
      throw human
    }
  }
}
