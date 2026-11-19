// Orca's own copies of agent CLIs, for hosts without the user's own; the user's install always wins.

import { delimiter, dirname } from 'node:path'
import type {
  ManagedAgentCli,
  ReportedRuntimeRelease
} from '../node-runtime/managed-runtime-release'
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
import {
  CURSOR_MINIMUM_VERSIONS,
  OPENCODE2_MINIMUM_VERSIONS,
  OPENCODE_MINIMUM_VERSIONS
} from '../acp/launch/acp-minimum-versions'
import { readInheritedPath } from '../ipc/pty/host-env/path'
import { resolvePathEnvKey } from '../pty/environment/windows-path-segment-merge'

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
  'omp'
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
  omp: OMP_MANAGED_CLI
}

export function isManagedAgentCli(agent: string): agent is ManagedAgentCliId {
  return Object.hasOwn(MANAGED_AGENT_CLIS, agent)
}

export function managedAgentCli(agent: ManagedAgentCliId): ManagedAgentCli {
  return MANAGED_AGENT_CLIS[agent]
}

const installedReleases = new Map<ManagedAgentCliId, ReportedRuntimeRelease>()

/** The installation reports each release it reads from disk, so lookups here never touch the disk. */
export function rememberManagedAgentRelease(
  agent: ManagedAgentCliId,
  release: ReportedRuntimeRelease | null
): void {
  if (release) {
    installedReleases.set(agent, release)
  } else {
    installedReleases.delete(agent)
  }
}

/** Orca's installed copy of `agent` on this host, used only when the user has none of their own. */
export function managedAgentCommand(agent: ManagedAgentCliId): string | null {
  const release = installedReleases.get(agent)
  if (!release) {
    return null
  }
  managedUseListener?.(agent)
  return MANAGED_AGENT_CLIS[agent].executable(release.folder)
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
    const release = installedReleases.get(agent)
    // A shell outlives updates, so it gets the link that follows the newest release.
    const folder = release && (release.link ?? release.folder)
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
