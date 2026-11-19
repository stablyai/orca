// Orca's own copies of agent CLIs, for hosts without the user's own; the user's install always wins.

import { delimiter, dirname } from 'node:path'
import type { ManagedRuntime } from '../node-runtime/managed-runtime-release'
import {
  CLAUDE_MANAGED_RUNTIME,
  claudeManagedExecutable,
  claudeManagedPlatform
} from '../claude/managed-runtime/claude-managed-runtime'
import {
  CODEX_MANAGED_RUNTIME,
  codexManagedExecutable,
  codexManagedTarget
} from '../codex/managed-runtime/codex-managed-runtime'
import { readInheritedPath } from '../ipc/pty/host-env/path'
import { resolvePathEnvKey } from '../pty/environment/windows-path-segment-merge'

export const MANAGED_AGENT_CLI_IDS = ['claude', 'codex'] as const
export type ManagedAgentCliId = (typeof MANAGED_AGENT_CLI_IDS)[number]

type ManagedAgentCli = {
  runtime: ManagedRuntime
  /** Whether this host has a build to download. */
  available: () => boolean
  executable: (folder: string) => string
}

const MANAGED_AGENT_CLIS: Record<ManagedAgentCliId, ManagedAgentCli> = {
  claude: {
    runtime: CLAUDE_MANAGED_RUNTIME,
    available: () => claudeManagedPlatform() !== null,
    executable: claudeManagedExecutable
  },
  codex: {
    runtime: CODEX_MANAGED_RUNTIME,
    available: () => codexManagedTarget() !== null,
    executable: codexManagedExecutable
  }
}

export function isManagedAgentCli(agent: string): agent is ManagedAgentCliId {
  return Object.hasOwn(MANAGED_AGENT_CLIS, agent)
}

export function managedAgentCli(agent: ManagedAgentCliId): ManagedAgentCli {
  return MANAGED_AGENT_CLIS[agent]
}

const installedFolders = new Map<ManagedAgentCliId, string>()

/** The installation reports each release it reads from disk, so lookups here never touch the disk. */
export function rememberManagedAgentRelease(agent: ManagedAgentCliId, folder: string | null): void {
  if (folder) {
    installedFolders.set(agent, folder)
  } else {
    installedFolders.delete(agent)
  }
}

/** Orca's installed copy of `agent` on this host, used only when the user has none of their own. */
export function managedAgentCommand(agent: ManagedAgentCliId): string | null {
  const folder = installedFolders.get(agent)
  if (!folder) {
    return null
  }
  managedUseListener?.(agent)
  return MANAGED_AGENT_CLIS[agent].executable(folder)
}

let managedUseListener: ((agent: ManagedAgentCliId) => void) | null = null

/** Told each time a launch resolves to Orca's copy, so updates follow real use instead of a timer. */
export function onManagedAgentUse(listener: (agent: ManagedAgentCliId) => void): void {
  managedUseListener = listener
}

/** Last on PATH, so sign-in commands and CLI tabs reach Orca's copies and never shadow the user's own. */
export function appendManagedAgentDirsToChildPath(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): void {
  delete env.ORCA_MANAGED_AGENT_PATH
  // Opening a terminal isn't use of an agent, so this reads the folders without the use hook.
  const folders = MANAGED_AGENT_CLI_IDS.flatMap((agent) => {
    const folder = installedFolders.get(agent)
    return folder ? [dirname(MANAGED_AGENT_CLIS[agent].executable(folder))] : []
  })
  if (folders.length === 0) {
    return
  }
  const key = resolvePathEnvKey(env, platform)
  const separator = platform === 'win32' ? ';' : delimiter
  const entries = readInheritedPath(env, platform).split(separator).filter(Boolean)
  const missing = folders.filter((folder) => !entries.includes(folder))
  if (missing.length > 0) {
    env[key] = [...entries, ...missing].join(separator)
  }
  // Startup files re-add them after a login profile rebuilds PATH.
  env.ORCA_MANAGED_AGENT_PATH = folders.join(separator)
}
