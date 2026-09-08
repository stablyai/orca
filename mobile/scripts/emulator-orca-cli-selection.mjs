import { existsSync } from 'node:fs'
import path from 'node:path'

const DEV_CLI_RELATIVE_PATH = path.join('config', 'scripts', 'orca-dev.mjs')

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function devCliAt(root, pathExists) {
  const candidate = path.resolve(root, DEV_CLI_RELATIVE_PATH)
  return pathExists(candidate) ? candidate : null
}

function findAncestorDevCli(cwd, pathExists) {
  let current = path.resolve(cwd)
  while (true) {
    const candidate = devCliAt(current, pathExists)
    if (candidate) {
      return candidate
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

export function resolveEmulatorOrcaCli({
  explicitCommand,
  managedCommand,
  devRepoRoot,
  worktree,
  cwd,
  platform = process.platform,
  pathExists = existsSync
}) {
  const explicit = nonEmpty(explicitCommand)
  if (explicit) {
    return { command: explicit, source: 'ORCA_CLI override' }
  }

  const managed = nonEmpty(managedCommand)
  if (managed) {
    return { command: managed, source: 'managed Orca terminal' }
  }

  const roots = [worktree, devRepoRoot].map(nonEmpty).filter(Boolean)
  for (const root of roots) {
    const command = devCliAt(root, pathExists)
    if (command) {
      return { command, source: 'worktree dev wrapper' }
    }
  }

  const ancestorCommand = findAncestorDevCli(cwd, pathExists)
  if (ancestorCommand) {
    return { command: ancestorCommand, source: 'nearest dev wrapper' }
  }

  return {
    command: platform === 'linux' ? 'orca-ide' : 'orca',
    source: 'installed Orca fallback'
  }
}

export function emulatorWorktreeSelector(worktree) {
  return `path:${path.resolve(worktree)}`
}

export function buildEmulatorOrcaArgs(command, args, worktree) {
  return ['emulator', command, ...args, '--worktree', emulatorWorktreeSelector(worktree), '--json']
}
