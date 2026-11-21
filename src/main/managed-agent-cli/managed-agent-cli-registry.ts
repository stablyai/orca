// Orca's own copies of agent CLIs, for hosts without the user's own; the user's install always wins.

import { dirname } from 'node:path'
import type { ManagedAgentCli } from '../node-runtime/managed-runtime-release'
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
import { acpRegistryManagedRuntime } from '../acp/registry/acp-registry-managed-runtime'
import { COPILOT_MANAGED_CLI } from '../copilot/copilot-managed-runtime'
import { GROK_MANAGED_CLI } from '../grok/grok-managed-runtime'
import { KIMI_MANAGED_CLI } from '../kimi/kimi-managed-runtime'
import { OMP_MANAGED_CLI } from '../omp/omp-managed-runtime'
import { AGY_MANAGED_CLI } from '../antigravity/agy-managed-runtime'
import {
  CURSOR_MINIMUM_VERSIONS,
  OPENCODE2_MINIMUM_VERSIONS,
  OPENCODE_MINIMUM_VERSIONS
} from '../acp/launch/acp-minimum-versions'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'

// Hermes ships only as a git checkout its installer builds with uv, so it stays the user's own install.
export const MANAGED_AGENT_CLI_IDS = [
  'claude',
  'codex',
  'opencode',
  'opencode2',
  'cursor',
  'copilot',
  'grok',
  'kimi',
  'omp',
  'antigravity'
] as const
export type ManagedAgentCliId = (typeof MANAGED_AGENT_CLI_IDS)[number]

const openCodeBinary = (platform: NodeJS.Platform): string =>
  platform === 'win32' ? 'opencode.exe' : 'opencode'

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
  },
  opencode: acpRegistryManagedRuntime({
    label: 'OpenCode',
    agent: 'opencode',
    registryId: 'opencode',
    command: openCodeBinary,
    minimumVersions: OPENCODE_MINIMUM_VERSIONS
  }),
  // The 2.x listing ships the `opencode` binary; `opencode2` is the name its own installer adds.
  opencode2: acpRegistryManagedRuntime({
    label: 'OpenCode 2',
    agent: 'opencode2',
    registryId: 'opencode-v2',
    command: openCodeBinary,
    minimumVersions: OPENCODE2_MINIMUM_VERSIONS,
    alias: (platform) => (platform === 'win32' ? 'opencode2.exe' : 'opencode2')
  }),
  cursor: acpRegistryManagedRuntime({
    label: 'Cursor',
    agent: 'cursor',
    registryId: 'cursor',
    command: (platform) =>
      platform === 'win32' ? 'dist-package/cursor-agent.cmd' : 'dist-package/cursor-agent',
    minimumVersions: CURSOR_MINIMUM_VERSIONS
  }),
  copilot: COPILOT_MANAGED_CLI,
  grok: GROK_MANAGED_CLI,
  kimi: KIMI_MANAGED_CLI,
  omp: OMP_MANAGED_CLI,
  // Stands in for `agy` only, never for the legacy ACP server Antigravity chats may run instead.
  antigravity: AGY_MANAGED_CLI
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

/** Whether Orca's copy of `agent` may replace `command`, the program a launch looks for. */
export function managedAgentStandsInFor(agent: ManagedAgentCliId, command: string): boolean {
  const only = MANAGED_AGENT_CLIS[agent].standsInFor
  return only === undefined || only === command
}

/** Whether `path` is inside Orca's own copies of `agent`, e.g. found on a PATH an Orca terminal
 *  passed on; such a path is never the user's own install. */
export function isManagedAgentCopyPath(agent: string, path: string): boolean {
  const folder = isManagedAgentCli(agent) ? installedFolders.get(agent) : undefined
  return folder !== undefined && isPathInsideOrEqual(dirname(folder), path)
}

/** Orca's copy standing in for `command` when the user has none; null without one. Only a launch
 *  counts as use: reads that just weigh the program pass `use: false`. */
export function managedAgentCommandFor(
  agent: string,
  command: string,
  { use }: { use: boolean } = { use: true }
): string | null {
  if (!isManagedAgentCli(agent) || !managedAgentStandsInFor(agent, command)) {
    return null
  }
  return use ? managedAgentCommand(agent) : installedManagedAgentCommand(agent)
}

/** Orca's installed copy of `agent`, read without counting as use. */
export function installedManagedAgentCommand(agent: ManagedAgentCliId): string | null {
  const folder = installedFolders.get(agent)
  return folder ? MANAGED_AGENT_CLIS[agent].executable(folder) : null
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
