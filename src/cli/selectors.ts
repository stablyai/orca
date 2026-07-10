import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import type {
  ComputerAppQuery,
  RuntimeWorktreeListResult,
  RuntimeWorktreeRecord
} from '../shared/runtime-types'
import { isPathInsideOrEqual } from '../shared/cross-platform-path'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'
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

function assertLocalCwdWorktreeSelector(selector: string, client: RuntimeClient): void {
  if (!client.isRemote) {
    return
  }
  // Why: a paired CLI's cwd belongs to the client machine, not the runtime
  // server, so cwd-derived worktree selectors are only valid locally.
  throw new RuntimeClientError(
    'invalid_argument',
    `${selector} is a local cwd shortcut and cannot be resolved against a remote runtime. Pass an explicit server-side worktree selector such as id:<id>, name:<displayName>, branch:<branch>, issue:<number>, or path:<absolute-server-path>.`
  )
}

function isWithinPath(parentPath: string, childPath: string): boolean {
  if (isPathInsideOrEqual(parentPath, childPath)) {
    return true
  }
  const relativePath = relative(parentPath, childPath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
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
    if (!isWithinPath(worktreePath, currentPath) || worktreePath.length <= enclosingPathLength) {
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
  return normalizeWorktreeSelector(value, cwd)
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
  return normalizeWorktreeSelector(value, cwd)
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
    return normalizeWorktreeSelector(value, cwd)
  }
  if (client.isRemote) {
    return undefined
  }
  // Default: auto-resolve from cwd
  try {
    return await resolveCurrentWorktreeSelector(cwd, client)
  } catch {
    // Not inside a managed worktree — no filter
    return undefined
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
    worktree: normalizeWorktreeSelector(explicitWorktree, cwd)
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

// Mirror getBrowserCommandTarget / getBrowserWorktreeSelector for emulator (workspace scoped by default + explicit --device/--emulator/--worktree; active from bridge for unqualified).
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
