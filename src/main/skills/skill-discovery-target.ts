import type { Repo } from '../../shared/repo-types'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import { parseSkillDiscoveryResult } from '../../shared/skills'
import {
  SKILL_SSH_RELAY_DISCOVER_METHOD,
  type SkillSshWorkspaceAuthority
} from '../../shared/skill-ssh-relay-contract'
import {
  SKILL_DISCOVER_CAPABILITY,
  SKILL_DISCOVER_UPDATE_REQUIRED_MESSAGE
} from '../../shared/skill-install-capability'
import {
  requireSkillSshRelayClient,
  skillSshRelayCapabilities,
  type SkillSshProviderSource,
  type SkillSshRelayClient
} from './skill-ssh-relay-client'
import { getDefaultWslDistro, getWslHome, parseWslPath, toLinuxPath } from '../wsl'
import { clearSkillRootScanCache, discoverSkills } from './discovery'
import { discoverSkillsInWsl } from './skill-discovery-wsl'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import { stablePathId } from './skill-discovery-sources'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isSkillRootUnavailableError, SkillScanCoalescer } from './skill-scan-coalescer'

// Why: off-host the unit of cost is the round trip (a wsl.exe boot, or an SSH
// relay request) plus one `find` per skill, so the whole result is what must be
// shared. The native path shares at root level instead, and only needs
// concurrent callers collapsed into one walk.
const REMOTE_RESULT_TTL_MS = 10_000
const MAX_CACHED_SKILL_TARGETS = 32
// Why below the renderer's 10s budget: a classified relay error must arrive
// before the renderer's own backstop turns it into a generic timeout.
//
// This timer is also the *only* thing bounding a stalled host. The scan
// coalescer's abandon-for-age aborts its own signal, which this task never
// reads, so that abort is a no-op here. The mux timer is what expires the
// request and sends `rpc.cancel`; discovery does not consume the relay request
// signal, so its shared filesystem scans can continue after the caller expires.
// Do not remove the client timeout on the belief the coalescer covers the stall.
const SSH_DISCOVERY_TIMEOUT_MS = 9_000

const targetScans = new SkillScanCoalescer<SkillDiscoveryResult>(MAX_CACHED_SKILL_TARGETS)

/** Drop every shared scan; used when a skill update run has rewritten disk. */
export function clearSkillDiscoveryCaches(): void {
  targetScans.clear()
  sshCapabilitiesByConnection.clear()
  clearSkillRootScanCache()
}

export type ResolvedSkillDiscoveryTarget =
  | { kind: 'native-host'; cwd: string | undefined }
  | { kind: 'wsl'; distro: string; homeDir: string; cwd: string }
  /** `workspace` is the authority this runtime resolved, never a caller path. */
  | { kind: 'ssh'; connectionId: string; workspace: SkillSshWorkspaceAuthority }

/** Targets whose filesystem this process can reach directly. Skill deletion and
 *  root rebuilding operate on real paths, so they take this rather than the full
 *  union — an SSH target's paths only mean something on the remote host. */
export type LocalSkillDiscoveryTarget = Exclude<ResolvedSkillDiscoveryTarget, { kind: 'ssh' }>

// Why the narrower return: this resolves a caller-supplied target descriptor,
// which cannot name an SSH host. The ssh variant is built only in the RPC layer
// from this runtime's own workspace records.
export function resolveSkillDiscoveryTarget(
  target: SkillDiscoveryTarget | undefined
): LocalSkillDiscoveryTarget {
  const projectRuntime = target?.projectRuntime
  if (projectRuntime?.status === 'repair-required') {
    throw new Error(
      `Project runtime requires repair before skill discovery: ${projectRuntime.repair.reason}`
    )
  }

  const wslRequested =
    (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') ||
    (!projectRuntime && target?.runtime === 'wsl')
  const wslDistro =
    projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
      ? projectRuntime.runtime.distro
      : !projectRuntime && target?.runtime === 'wsl'
        ? target.wslDistro?.trim() || getDefaultWslDistro()
        : null
  if (wslRequested && !wslDistro) {
    throw new Error('No WSL distribution is available for skill discovery.')
  }
  if (!wslDistro) {
    return { kind: 'native-host', cwd: target?.cwd?.trim() || undefined }
  }
  if (process.platform !== 'win32') {
    throw new Error('WSL skill discovery is only available on Windows.')
  }
  const homeDir = getWslHome(wslDistro)
  if (!homeDir) {
    throw new Error(`Could not resolve the WSL home directory for ${wslDistro}.`)
  }

  const requestedCwd = target?.cwd?.trim()
  const parsedCwd = requestedCwd ? parseWslPath(requestedCwd) : null
  if (parsedCwd && parsedCwd.distro.toLowerCase() !== wslDistro.toLowerCase()) {
    throw new Error(
      `The workspace belongs to WSL distribution ${parsedCwd.distro}, not ${wslDistro}.`
    )
  }
  const linuxHomeDir = toLinuxPath(homeDir)
  const cwd = parsedCwd?.linuxPath ?? (requestedCwd ? toLinuxPath(requestedCwd) : linuxHomeDir)
  return { kind: 'wsl', distro: wslDistro, homeDir: linuxHomeDir, cwd }
}

// Why: repos widen the native root set, so two targets that differ only by the
// stored repo list must not share a scan. Paths are digested rather than joined
// so the key cannot grow with a large repo list.
function repoDigest(repos: readonly Repo[]): string {
  return stablePathId(
    repos
      // Why: the source builder keeps only locally-executed repos, so the same
      // path reassigned to another execution host is a different root set.
      .map((repo) => `${getRepoExecutionHostId(repo)}\0${repo.path}`)
      .sort((left, right) => left.localeCompare(right))
      // NUL is the one byte a path cannot contain, so no repo list can be spelled
      // two ways that digest alike.
      .join('\0')
  )
}

// Keys use exact paths — lowercasing would alias two roots that are distinct on Linux.
function scanKey(
  target: ResolvedSkillDiscoveryTarget,
  repos: readonly Repo[],
  providerRootOverrides: SkillProviderRootOverrides | undefined
): string {
  const providerRoots = stablePathId(
    Object.entries(providerRootOverrides ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, root]) => `${provider}\0${root}`)
      .join('\0')
  )
  const targetKey =
    target.kind === 'wsl'
      ? `wsl\0${target.distro}\0${target.homeDir}\0${target.cwd}`
      : target.kind === 'ssh'
        ? // Why connectionId leads: the same absolute path exists on every host,
          // so a key built from the path alone would serve one host's scan to
          // another. Workspace id is included because two workspaces can share a
          // path across a rename.
          `ssh\0${target.connectionId}\0${target.workspace.kind}\0${target.workspace.id}\0${target.workspace.path}`
        : `native\0${target.cwd ?? ''}\0${target.cwd ? '' : repoDigest(repos)}`
  return `${targetKey}\0${providerRoots}`
}

/** Why the capability handshake rather than a method-not-found code: an older
 *  relay's error reaches the picker as an unexplained failure, while the
 *  advertised capability list says up front that the host needs a newer relay. */
// Why memoized: relay.status is a 15s-timeout round trip that answered for this
// connection already. Probing per scan doubled the round trips and pushed the
// worst case far past the renderer's budget. Cleared with the scan caches, so a
// reconnect re-probes rather than trusting a dead connection's answer.
const sshCapabilitiesByConnection = new Map<string, Promise<string[]>>()

/** Drop a connection's memoized capabilities when its session ends. Without
 *  this the probe answer outlives the relay it described, so a host upgraded by
 *  the reconnect we asked the user to perform still reports the old capability
 *  set and the "reconnect this host" message never clears. */
export function forgetSshSkillDiscoveryCapabilities(connectionId: string): void {
  sshCapabilitiesByConnection.delete(connectionId)
}

function cachedSshCapabilities(
  connectionId: string,
  client: SkillSshRelayClient
): Promise<string[]> {
  const existing = sshCapabilitiesByConnection.get(connectionId)
  if (existing) {
    return existing
  }
  const probe = skillSshRelayCapabilities(client).catch((error: unknown) => {
    sshCapabilitiesByConnection.delete(connectionId)
    throw error
  })
  sshCapabilitiesByConnection.set(connectionId, probe)
  return probe
}

async function discoverSkillsOnSshHost(
  target: Extract<ResolvedSkillDiscoveryTarget, { kind: 'ssh' }>,
  sshProvider: SkillSshProviderSource | undefined
): Promise<SkillDiscoveryResult> {
  if (!sshProvider) {
    throw new Error('skill-discovery-ssh-relay-unavailable')
  }
  const client = requireSkillSshRelayClient(sshProvider)
  const capabilities = await cachedSshCapabilities(target.connectionId, client)
  if (!capabilities.includes(SKILL_DISCOVER_CAPABILITY)) {
    throw new Error(SKILL_DISCOVER_UPDATE_REQUIRED_MESSAGE)
  }
  const raw = await client(
    SKILL_SSH_RELAY_DISCOVER_METHOD,
    { workspace: target.workspace },
    { timeoutMs: SSH_DISCOVERY_TIMEOUT_MS }
  )
  // Why parse: the relay frame is remote input before it reaches renderer state.
  return parseSkillDiscoveryResult(raw)
}

export async function discoverSkillsOnTarget(
  target: ResolvedSkillDiscoveryTarget,
  repos: readonly Repo[],
  options: {
    refresh?: boolean
    providerRootOverrides?: SkillProviderRootOverrides
    sshProvider?: SkillSshProviderSource
  } = {}
): Promise<SkillDiscoveryResult> {
  const refresh = options.refresh === true
  const sshProvider = options.sshProvider
  try {
    const outcome = await targetScans.run(
      scanKey(target, repos, options.providerRootOverrides),
      { ttlMs: target.kind === 'native-host' ? 0 : REMOTE_RESULT_TTL_MS, refresh },
      async () => {
        if (target.kind === 'ssh') {
          return discoverSkillsOnSshHost(target, sshProvider)
        }
        if (target.kind === 'wsl') {
          return discoverSkillsInWsl({
            distro: target.distro,
            homeDir: target.homeDir,
            cwd: target.cwd,
            providerRootOverrides: options.providerRootOverrides
          })
        }
        return target.cwd
          ? discoverSkills({
              repos: [],
              cwd: target.cwd,
              refresh,
              providerRootOverrides: options.providerRootOverrides
            })
          : discoverSkills({
              repos: [...repos],
              refresh,
              providerRootOverrides: options.providerRootOverrides
            })
      }
    )
    return outcome.value
  } catch (error) {
    if (!isSkillRootUnavailableError(error)) {
      throw error
    }
    // Why not an empty result: this layer scans whole targets, so it has no
    // partial answer to degrade to, and returning zero skills would read as
    // "nothing is installed" and re-offer installs for skills that are present.
    // An error keeps the picker's retry affordance and says something true.
    throw new Error('Skill discovery is still reading a slow location. Try again.', {
      cause: error
    })
  }
}
