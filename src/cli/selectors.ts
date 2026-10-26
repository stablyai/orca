import { resolve as resolvePath } from 'node:path'
import type { ComputerAppQuery, RuntimeWorktreeListResult } from '../shared/runtime-types'
import {
  isWslUncPathForCallerLinuxPath,
  isWslUncPathForLinuxMountedPath
} from '../shared/cross-platform-path'
import { parseWslUncPath } from '../shared/wsl-paths'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import { getOptionalStringFlag, getPresentStringFlag, getRequiredStringFlag } from './flags'
import {
  getCallerExecutionHostId,
  resolveCallerPaneWorktreeSelector,
  selectEnclosingWorktreeSelectionOnHost,
  type HostScopedWorktreeSelection
} from './caller-host-worktree-selection'

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

/** Resolve Linux selectors to stored UNC paths here, where the caller's distro is known. */
export async function resolveCallerDistroPathSelector(
  selector: string,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  // A UNC cwd proves Windows/WSL routing; WSL_DISTRO_NAME is also set for Linux-native runtimes.
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
  // Preserve unmatched input verbatim; synthesizing a UNC path could guess the wrong distro.
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
  // A paired CLI's cwd belongs to the client filesystem, so it cannot identify server worktrees.
  throw new RuntimeClientError(
    'invalid_argument',
    `${selector} is a local cwd shortcut and cannot be resolved against a remote runtime. Pass an explicit server-side worktree selector such as identity:<identity>, id:<repo-id>::<path>, name:<displayName>, branch:<branch>, issue:<number>, or path:<absolute-server-path>.`
  )
}

export async function resolveCurrentWorktreeSelector(
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  return (await resolveCurrentWorktreeSelection(cwd, client)).selector
}

export async function resolveCurrentWorktreeSelection(
  cwd: string,
  client: RuntimeClient
): Promise<HostScopedWorktreeSelection> {
  assertLocalCwdWorktreeSelector('current', client)

  const worktrees = await client.call<RuntimeWorktreeListResult>('worktree.list', {
    limit: 10_000
  })
  // Preserve the repo id: duplicate registrations can make a bare path selector ambiguous.
  const selection = selectEnclosingWorktreeSelectionOnHost(
    worktrees.result.worktrees,
    cwd,
    getCallerExecutionHostId(),
    process.env.ORCA_WORKTREE_ID
  )
  if (!selection) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No Orca-managed worktree contains the current directory: ${resolvePath(cwd)}`
    )
  }
  return selection
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

// Remote commands leave worktree unset to use server-side focus.
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
  try {
    return await resolveCurrentWorktreeSelector(cwd, client)
  } catch {
    return undefined
  }
}

export async function getTerminalHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient,
  options: { requireUnambiguous?: boolean } = {}
): Promise<string> {
  const explicit = getPresentStringFlag(flags, 'terminal')
  if (explicit) {
    return explicit
  }
  const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
  const response = await client.call<{ handle: string }>('terminal.resolveActive', {
    worktree,
    ...(options.requireUnambiguous ? { requireUnambiguous: true } : {})
  })
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
    const scoped = await resolveCallerPaneWorktreeSelector(terminalWorktreeId, client)
    if (scoped) {
      return scoped
    }
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
    return {
      device: device || undefined,
      emulator: emulator || undefined,
      worktree
    }
  }
  return { worktree }
}
