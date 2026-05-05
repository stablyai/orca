import { isAbsolute, relative, resolve as resolvePath } from 'path'
import type { RuntimeWorktreeListResult } from '../shared/runtime-types'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'
import { getOptionalStringFlag, getRequiredStringFlag } from './flags'

export type BrowserCliTarget = {
  worktree?: string
  page?: string
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

function isWithinPath(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

export async function resolveCurrentWorktreeSelector(
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  const currentPath = resolvePath(cwd)
  const worktrees = await client.call<RuntimeWorktreeListResult>('worktree.list', {
    limit: 10_000
  })
  const enclosingWorktree = worktrees.result.worktrees
    .filter((worktree) => isWithinPath(resolvePath(worktree.path), currentPath))
    .sort((left, right) => right.path.length - left.path.length)[0]

  if (!enclosingWorktree) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No Orca-managed worktree contains the current directory: ${currentPath}`
    )
  }

  // Why: users expect "active/current" to mean the enclosing managed worktree
  // even from nested subdirectories. The CLI resolves that shell-local concept
  // to the deepest matching worktree root, then hands the runtime a normal
  // path selector so selector semantics stay centralized in one layer.
  return buildCurrentWorktreeSelector(enclosingWorktree.path)
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
    return await resolveCurrentWorktreeSelector(cwd, client)
  }
  return normalizeWorktreeSelector(value, cwd)
}

// Why: browser commands default to the current worktree (auto-resolve from cwd).
// --worktree all bypasses filtering. Omitting --worktree auto-resolves.
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
      return await resolveCurrentWorktreeSelector(cwd, client)
    }
    return normalizeWorktreeSelector(value, cwd)
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
