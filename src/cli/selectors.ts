import { resolve as resolvePath } from 'node:path'
import type {
  ComputerAppQuery,
  RuntimeWorktreeListResult,
  RuntimeWorktreeRecord
} from '../shared/runtime-types'
import {
  isPathInsideOrEqual,
  isWslUncPathForCallerLinuxPath,
  isWslUncPathForLinuxMountedPath
} from '../shared/cross-platform-path'
import { parseWslUncPath } from '../shared/wsl-paths'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import { getOptionalStringFlag, getRequiredStringFlag } from './flags'

export type BrowserCliTarget = {
  worktree?: string
  page?: string
}

export type ComputerCliTarget = {
  session?: string
  worktree?: string
  app: ComputerAppQuery
}

export function buildCurrentWorktreeSelector(cwd: string): string {
  return `path:${resolvePath(cwd)}`
}

export function normalizeWorktreeSelector(selector: string, cwd: string): string {
  if (selector === 'active' || selector === 'current') {
    return buildCurrentWorktreeSelector(cwd)
  }
  return selector
}

/**
 * Rewrites the Linux path a WSL shell prints into the UNC path the runtime stored (#16628).
 *
 * Why here and not in the runtime: only the CLI sits in the distro, so only it can
 * prove which distro the typed path belongs to. Translating once at this chokepoint
 * covers `worktree show`, `terminal list --worktree` and `worktree rm --worktree`.
 */
export async function resolveCallerDistroPathSelector(
  selector: string,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  // Why not WSL_DISTRO_NAME: it is also set for a Linux-native CLI whose runtime stores
  // POSIX paths, so it would name a distro for a caller that has none. ORCA_CLI_CWD, which
  // the WSL launcher always sets and which arrives here as the invocation cwd, proves it.
  const callerDistro = parseWslUncPath(cwd)?.distro
  const linuxPath = selector.startsWith('path:') ? selector.slice(5) : ''
  const isLinuxMountedPath = /^\/mnt\/[A-Za-z](?:\/|$)/.test(linuxPath)
  if (
    (!callerDistro && !isLinuxMountedPath) ||
    client.isRemote ||
    !linuxPath.startsWith('/') ||
    linuxPath.startsWith('//') ||
    // Backslash is a legal Linux filename character but a separator once a path reads as UNC.
    linuxPath.includes('\\')
  ) {
    return selector
  }
  const worktrees = await client.call<RuntimeWorktreeListResult>('worktree.list', {
    limit: 10_000
  })
  const match = worktrees.result.worktrees.find((worktree) =>
    isLinuxMountedPath
      ? isWslUncPathForLinuxMountedPath(worktree.path, linuxPath)
      : isWslUncPathForCallerLinuxPath(worktree.path, linuxPath, callerDistro!)
  )
  // Why the stored spelling rather than a synthesized UNC path: an unmatched selector must
  // reach the runtime verbatim and fail as the caller typed it, never as a guessed distro.
  return match ? `path:${match.path}` : selector
}

export async function normalizeWorktreeSelectorForCaller(
  selector: string,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  return await resolveCallerDistroPathSelector(
    normalizeWorktreeSelector(selector, cwd),
    cwd,
    client
  )
}

function assertLocalCwdWorktreeSelector(selector: string, client: RuntimeClient): void {
  if (!client.isRemote) {
    return
  }
  // Why: a paired CLI's cwd belongs to the client machine, not the runtime
  // server, so cwd-derived worktree selectors are only valid locally.
  throw new RuntimeClientError(
    'invalid_argument',
    `${selector} is a local cwd shortcut and cannot be resolved against a remote runtime. Pass an explicit server-side worktree selector such as identity:<identity>, id:<repo-id>::<path>, name:<displayName>, branch:<branch>, issue:<number>, or path:<absolute-server-path>.`
  )
}

export async function resolveCurrentWorktreeSelector(
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  assertLocalCwdWorktreeSelector('current', client)

  const currentPath = resolvePath(cwd)
  const worktrees = await client.call<RuntimeWorktreeListResult>('worktree.list', {
    limit: 10_000
  })
  let enclosingWorktree: RuntimeWorktreeRecord | undefined
  let enclosingPathLength = -1
  for (const worktree of worktrees.result.worktrees) {
    const worktreePath = resolvePath(worktree.path)
    if (
      !isPathInsideOrEqual(worktreePath, currentPath) ||
      worktreePath.length <= enclosingPathLength
    ) {
      continue
    }
    enclosingWorktree = worktree
    enclosingPathLength = worktreePath.length
  }

  if (!enclosingWorktree) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No Orca-managed worktree contains the current directory: ${currentPath}`
    )
  }

  // Why: users expect "active/current" to mean the enclosing managed worktree
  // even from nested subdirectories. Resolve to the concrete runtime id here:
  // duplicate repo registrations can expose the same Git worktree path, and a
  // path selector would throw selector_ambiguous after losing the repo id.
  return `id:${enclosingWorktree.id}`
}

export async function getOptionalWorktreeSelector(
  flags: Map<string, string | boolean>,
  name: string,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const value = getOptionalStringFlag(flags, name)
  if (!value) {
    return undefined
  }
  if (value === 'active' || value === 'current') {
    assertLocalCwdWorktreeSelector(value, client)
    return await resolveCurrentWorktreeSelector(cwd, client)
  }
  return await normalizeWorktreeSelectorForCaller(value, cwd, client)
}

export async function getRequiredWorktreeSelector(
  flags: Map<string, string | boolean>,
  name: string,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  const value = getRequiredStringFlag(flags, name)
  if (value === 'active' || value === 'current') {
    assertLocalCwdWorktreeSelector(value, client)
    return await resolveCurrentWorktreeSelector(cwd, client)
  }
  return await normalizeWorktreeSelectorForCaller(value, cwd, client)
}

// Why: local browser commands default to the current worktree by auto-resolving
// from cwd. Remote commands omit worktree so the runtime uses server-side focus.
export async function getBrowserWorktreeSelector(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const value = getOptionalStringFlag(flags, 'worktree')
  if (value === 'all') {
    return undefined
  }
  if (value) {
    if (value === 'active' || value === 'current') {
      assertLocalCwdWorktreeSelector(value, client)
      return await resolveCurrentWorktreeSelector(cwd, client)
    }
    return await normalizeWorktreeSelectorForCaller(value, cwd, client)
  }
  if (client.isRemote) {
    return undefined
  }
  // Default: auto-resolve from cwd
  try {
    return await resolveCurrentWorktreeSelector(cwd, client)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'selector_not_found') {
      // Not inside a managed worktree — no filter.
      return undefined
    }
    throw error
  }
}

// Why: mirrors browser's implicit active-tab targeting. When --terminal is
// omitted, resolve the active terminal in the current worktree so commands
// like `orca terminal send --text "hello" --enter` Just Work.
export async function getTerminalHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  const explicit = getOptionalStringFlag(flags, 'terminal')
  if (explicit) {
    return explicit
  }
  const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
  const response = await client.call<{ handle: string }>('terminal.resolveActive', { worktree })
  return response.result.handle
}

export async function getBrowserCommandTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<BrowserCliTarget> {
  const page = getOptionalStringFlag(flags, 'page')
  if (!page) {
    return {
      worktree: await getBrowserWorktreeSelector(flags, cwd, client)
    }
  }

  const explicitWorktree = getOptionalStringFlag(flags, 'worktree')
  if (!explicitWorktree || explicitWorktree === 'all') {
    return { page }
  }
  if (explicitWorktree === 'active' || explicitWorktree === 'current') {
    assertLocalCwdWorktreeSelector(explicitWorktree, client)
    return {
      page,
      worktree: await resolveCurrentWorktreeSelector(cwd, client)
    }
  }
  return {
    page,
    worktree: await normalizeWorktreeSelectorForCaller(explicitWorktree, cwd, client)
  }
}

export async function getComputerCommandTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<ComputerCliTarget> {
  const app = getRequiredStringFlag(flags, 'app')
  const session = getOptionalStringFlag(flags, 'session')
  const worktree = getOptionalStringFlag(flags, 'worktree')
  if (session && worktree) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Computer-use targeting accepts either --session or --worktree, not both'
    )
  }
  if (session) {
    return { session, app }
  }
  return {
    app,
    worktree: await getBrowserWorktreeSelector(flags, cwd, client)
  }
}

// Match browser targeting: workspace by default, explicit device/emulator/worktree overrides.
export type EmulatorCliTarget = {
  worktree?: string
  device?: string
  emulator?: string // Orca id from list
}

export async function getEmulatorWorktreeSelector(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const explicit = getOptionalStringFlag(flags, 'worktree')
  if (explicit === 'all') {
    return undefined
  }
  if (explicit) {
    if (explicit === 'active' || explicit === 'current') {
      assertLocalCwdWorktreeSelector(explicit, client)
      return resolveCurrentWorktreeSelector(cwd, client)
    }
    return explicit
  }
  if (client.isRemote) {
    return undefined
  }
  const terminalWorktreeId = process.env.ORCA_WORKTREE_ID
  if (terminalWorktreeId?.trim()) {
    return terminalWorktreeId
  }
  const folderWorkspaceId = process.env.ORCA_WORKSPACE_ID?.trim()
  if (folderWorkspaceId?.startsWith('folder:')) {
    return folderWorkspaceId
  }
  try {
    return await resolveCurrentWorktreeSelector(cwd, client)
  } catch {
    return undefined
  }
}

export async function getEmulatorCommandTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<EmulatorCliTarget> {
  const device = getOptionalStringFlag(flags, 'device')
  const emulator = getOptionalStringFlag(flags, 'emulator')
  const worktree = await getEmulatorWorktreeSelector(flags, cwd, client)
  if (device || emulator) {
    return { device: device || undefined, emulator: emulator || undefined, worktree }
  }
  return { worktree }
}
