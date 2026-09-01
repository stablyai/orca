// Main-side host-state provider for agent launches (U3). Given a spawn surface's
// execution descriptor (local, WSL, SSH, or runtime), it derives the fixed
// AgentLaunchSpawnTarget the resolver consumes: platform, shell, isRemote, the
// stable execution-host id, the target home path for `~` expansion, the stock
// detection snapshot, and the cross-host transport-confidentiality signal.
//
// The provider NEVER fabricates a value it cannot observe. Detection is null when
// unavailable (never an empty set standing in for "unknown"); the target home is
// null when the host has not resolved it (the resolver then fails
// missing_target_home only for `~`-prefixed values); confidentiality is undefined
// for same-host launches and conservatively false for a cross-host channel whose
// binding cannot be proven. Detection/home resolution are injected async host
// reads so this module stays electron-free and unit-testable.

import { homedir } from 'node:os'
import type { BuiltInTuiAgent, GlobalSettings } from '../../shared/types'
import type { AgentLaunchSpawnRequest } from '../../shared/agent-launch-spawn-request'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type {
  AgentLaunchExecutionHostId,
  AgentLaunchSnapshot
} from '../../shared/agent-launch-host-contract'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { AgentLaunchSpawnTarget } from './agent-launch-spawn'

/** The distro a WSL-runtime project executes in, whatever its worktree path looks
 *  like; a repair-required WSL project still owns the runtime, so it counts. */
function projectRuntimeWslDistro(
  projectRuntime: ProjectExecutionRuntimeResolution | null | undefined
): string | undefined {
  if (!projectRuntime) {
    return undefined
  }
  return projectRuntime.status === 'resolved'
    ? projectRuntime.runtime.kind === 'wsl'
      ? projectRuntime.runtime.distro
      : undefined
    : (projectRuntime.repair.preferredRuntime.distro ?? undefined)
}

/** The execution surface a launch targets. isRemote/platform/executionHostId are
 *  derived from this shape; nothing is copied from a client payload. */
export type AgentLaunchHostDescriptor =
  | { kind: 'local'; platform: NodeJS.Platform; shell?: AgentStartupShell }
  // A WSL surface is never 'local': its `wsl:` host id is what makes the
  // resolver translate Windows/UNC values to Linux form. Detection/home stay
  // honest unknowns until a caller can probe the distro's own PATH/$HOME.
  | { kind: 'wsl'; distro: string; shell?: AgentStartupShell }
  | {
      kind: 'ssh'
      connectionId: string
      platform: NodeJS.Platform
      shell?: AgentStartupShell
    }
  | {
      kind: 'runtime'
      environmentId: string
      platform: NodeJS.Platform
      /** Runtime environments are separate hosts by default; a caller that knows
       *  the env is in-process may set false. */
      isRemote?: boolean
      shell?: AgentStartupShell
    }

/** The stable execution-host id, reusing the shared SSH/runtime encoders and this
 *  feature's `wsl:${distro}` variant (the shared ExecutionHostId grammar has no
 *  WSL arm). */
export function executionHostIdForDescriptor(
  descriptor: AgentLaunchHostDescriptor
): AgentLaunchExecutionHostId {
  switch (descriptor.kind) {
    case 'local':
      return 'local'
    case 'wsl':
      return `wsl:${encodeURIComponent(descriptor.distro)}`
    case 'ssh':
      return toSshExecutionHostId(descriptor.connectionId)
    case 'runtime':
      return toRuntimeExecutionHostId(descriptor.environmentId)
  }
}

/** WSL always executes a Linux userland; every other descriptor names its own
 *  terminal-target platform. */
export function platformForDescriptor(descriptor: AgentLaunchHostDescriptor): NodeJS.Platform {
  return descriptor.kind === 'wsl' ? 'linux' : descriptor.platform
}

/** SSH and (by default) runtime are separate hosts; local and WSL execute on this
 *  machine, matching repoIsRemote (connectionId-only) semantics. */
export function isRemoteForDescriptor(descriptor: AgentLaunchHostDescriptor): boolean {
  if (descriptor.kind === 'ssh') {
    return true
  }
  if (descriptor.kind === 'runtime') {
    return descriptor.isRemote ?? true
  }
  return false
}

/** Conservative confidentiality: same-host launches carry no cross-host transport
 *  (undefined). SSH is authenticated and confidential (true). A runtime channel's
 *  binding cannot be proven from host state alone, so env-bearing launches into it
 *  fail closed (false) unless a caller overrides with an identified binding. */
export function defaultTransportConfidentiality(
  descriptor: AgentLaunchHostDescriptor
): boolean | undefined {
  if (descriptor.kind === 'local' || descriptor.kind === 'wsl') {
    return undefined
  }
  if (descriptor.kind === 'ssh') {
    return true
  }
  return false
}

/** Filter a raw detected-agent list to the stock base agents the resolver gates
 *  on. null/undefined input means detection is unavailable and is preserved as
 *  null (unknown); an empty array is "detection ran, nothing installed" and stays
 *  an empty set — the two must not collapse. */
export function toStockBaseAgentSet(
  detected: readonly string[] | null | undefined
): ReadonlySet<BuiltInTuiAgent> | null {
  if (detected === null || detected === undefined) {
    return null
  }
  const set = new Set<BuiltInTuiAgent>()
  for (const id of detected) {
    if (isBuiltInTuiAgent(id)) {
      set.add(id)
    }
  }
  return set
}

/** Map a terminal spawn's connection + cwd to its execution-host descriptor.
 *  An SSH target (connectionId present) infers platform from the remote cwd's
 *  path shape — the same heuristic the runtime uses — because the IPC boundary
 *  has no synchronous remote-platform probe; its home/detection stay honest
 *  unknowns until a caller that can probe supplies them. A WSL UNC cwd is its
 *  own `wsl:` host (never local, or its UNC/drive paths would reach the Linux
 *  argv untranslated) — matching the runtime's buildTerminalAgentLaunchDescriptor
 *  — and keeps honest-unknown home/detection. Every other target is local. */
export function describeSpawnExecutionHost(args: {
  connectionId?: string | null
  cwd?: string | null
  /** The pane's per-tab Windows shell, which beats the global setting at spawn
   *  time — host-built argv must be quoted for the shell that actually runs it. */
  shellOverride?: string | null
  terminalWindowsShell?: string | null
  /** The project's Windows execution runtime. A WSL project runs bash even when
   *  its worktree is a Windows drive path, which no cwd inspection can tell. */
  projectRuntime?: ProjectExecutionRuntimeResolution | null
}): AgentLaunchHostDescriptor {
  if (args.connectionId) {
    return {
      kind: 'ssh',
      connectionId: args.connectionId,
      platform: args.cwd && isWindowsAbsolutePathLike(args.cwd) ? 'win32' : 'linux'
    }
  }
  const wslDistro =
    (args.cwd ? parseWslUncPath(args.cwd)?.distro : undefined) ??
    projectRuntimeWslDistro(args.projectRuntime)
  if (wslDistro) {
    return { kind: 'wsl', distro: wslDistro }
  }
  const shell = resolveLocalWindowsAgentStartupShell({
    platform: process.platform,
    isRemote: false,
    shellOverride: args.shellOverride,
    terminalWindowsShell: args.terminalWindowsShell
  })
  return {
    kind: 'local',
    platform: process.platform,
    ...(shell ? { shell } : {})
  }
}

export type AgentLaunchHostStateDeps = {
  getSettings: () => GlobalSettings
  getCatalogRevision: () => number
  /** Detect stock base agents on the target's baseline PATH. Return null when
   *  detection is genuinely unavailable — never an empty list to mean unknown. */
  detectStockBaseAgents: (
    descriptor: AgentLaunchHostDescriptor,
    baseAgents?: readonly BuiltInTuiAgent[]
  ) => Promise<readonly string[] | null>
  /** Resolve the target host's home dir for `~` expansion, or null when the host
   *  has not resolved it (SSH before resolveHome, an unknown WSL distro $HOME). */
  resolveTargetHomePath: (descriptor: AgentLaunchHostDescriptor) => Promise<string | null>
  /** Resolve a target-owned shell when the descriptor cannot carry one
   * synchronously (notably a native-Windows SSH relay). */
  resolveStartupShell?: (
    descriptor: AgentLaunchHostDescriptor
  ) => Promise<AgentStartupShell | undefined>
  /** Override the default confidentiality derivation when a cross-host channel's
   *  binding is identifiable (e.g. a runtime env reached over SSH). */
  resolveTransportConfidentiality?: (descriptor: AgentLaunchHostDescriptor) => boolean | undefined
}

/** The surface-specific host state a launch resolves against: the live settings
 *  accessors and the fixed target/variables snapshot. Settings and the normalized
 *  catalog are read live per resolution by resolveAgentLaunchSpawn; the target and
 *  variables are the immutable per-surface derivation captured here. */
export type AgentLaunchHostState = {
  getSettings: () => GlobalSettings
  getCatalogRevision: () => number
  target: AgentLaunchSpawnTarget
  variables: { repoPath: string | null; worktreePath: string | null }
}

/** Restrict an eligibility probe only when the base identity is immutable during
 * the async probe. Defaults and custom definitions use full detection because a
 * settings edit can change their base before synchronous launch resolution. */
export function detectionBaseAgentsForLaunch(
  request: AgentLaunchSpawnRequest,
  snapshot?: AgentLaunchSnapshot
): readonly BuiltInTuiAgent[] | undefined {
  if (snapshot) {
    return [snapshot.baseAgent]
  }
  if (request.selection.kind === 'default') {
    return undefined
  }
  return isBuiltInTuiAgent(request.selection.agent) ? [request.selection.agent] : undefined
}

/** Derive the per-surface host state for a launch. Performs the async host reads
 *  (detection, target home) once, up front, so the boundary's synchronous
 *  re-resolution inside the admission coordinator only re-reads settings. */
export async function deriveAgentLaunchHostState(
  deps: AgentLaunchHostStateDeps,
  descriptor: AgentLaunchHostDescriptor,
  variables: { repoPath?: string | null; worktreePath?: string | null },
  options: { detectionBaseAgents?: readonly BuiltInTuiAgent[] } = {}
): Promise<AgentLaunchHostState> {
  const platform = platformForDescriptor(descriptor)
  const isRemote = isRemoteForDescriptor(descriptor)
  const executionHostId = executionHostIdForDescriptor(descriptor)
  const [detected, targetHomePath, resolvedShell] = await Promise.all([
    options.detectionBaseAgents === undefined
      ? deps.detectStockBaseAgents(descriptor)
      : deps.detectStockBaseAgents(descriptor, options.detectionBaseAgents),
    deps.resolveTargetHomePath(descriptor),
    descriptor.shell ? Promise.resolve(undefined) : deps.resolveStartupShell?.(descriptor)
  ])
  const confidentiality = (deps.resolveTransportConfidentiality ?? defaultTransportConfidentiality)(
    descriptor
  )

  const target: AgentLaunchSpawnTarget = {
    platform,
    ...(descriptor.shell || resolvedShell ? { shell: descriptor.shell ?? resolvedShell } : {}),
    isRemote,
    executionHostId,
    targetHomePath: targetHomePath ?? null,
    detectedStockBaseAgents: toStockBaseAgentSet(detected),
    ...(confidentiality !== undefined ? { transportConfidentialityAvailable: confidentiality } : {})
  }

  return {
    getSettings: deps.getSettings,
    getCatalogRevision: deps.getCatalogRevision,
    target,
    variables: {
      repoPath: variables.repoPath ?? null,
      worktreePath: variables.worktreePath ?? null
    }
  }
}

/** Default detection resolver: detection unavailable (unknown). Callers that can
 *  run real stock detection inject their own; the honest default never claims an
 *  agent is missing. */
export const detectionUnavailable = async (): Promise<null> => null

/** Default home resolver: this machine's home dir for a same-platform local
 *  target, null otherwise. A divergent-platform local host (WSL) owns its own
 *  $HOME, so claiming this machine's would expand `~` to a Windows path. */
export async function resolveLocalTargetHomePath(
  descriptor: AgentLaunchHostDescriptor
): Promise<string | null> {
  return descriptor.kind === 'local' && descriptor.platform === process.platform ? homedir() : null
}
