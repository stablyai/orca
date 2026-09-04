import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  agentLaunchProfileIdFromEnv,
  isAgentLaunchProfileId
} from '../../shared/agent-launch-profile/agent-launch-profile'
import { getOrcaUserDataPath } from '../codex/codex-home-paths'

// Why: the profile is baked into a PTY's environment at spawn and the daemon keeps that shell
// alive across app restarts, so only an on-disk record can tell a reattached pane's profile.
// Keyed by pty id like the Codex pane account registry, which this mirrors for every agent.

type PaneLaunchProfileRegistryFile = {
  version: 1
  panes: Record<string, string>
}

const MAX_TRACKED_PANES = 2000

let cached: PaneLaunchProfileRegistryFile | null = null

function registryPath(): string {
  return join(getOrcaUserDataPath(), 'agent-launch-profile-panes.json')
}

function readRegistry(): PaneLaunchProfileRegistryFile {
  if (cached) {
    return cached
  }
  const empty: PaneLaunchProfileRegistryFile = { version: 1, panes: {} }
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), 'utf-8')) as unknown
    const panes = (parsed as Partial<PaneLaunchProfileRegistryFile> | null)?.panes
    if (panes && typeof panes === 'object' && !Array.isArray(panes)) {
      for (const [ptyId, profileId] of Object.entries(panes)) {
        if (ptyId && isAgentLaunchProfileId(profileId)) {
          empty.panes[ptyId] = profileId
        }
      }
    }
  } catch {
    // Why: a missing or unreadable file only loses an attribution hint; never fail a spawn over it.
  }
  cached = empty
  return empty
}

function writeRegistry(registry: PaneLaunchProfileRegistryFile): void {
  const target = registryPath()
  const temporary = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(registry)}\n`, { encoding: 'utf-8', mode: 0o600 })
    renameSync(temporary, target)
  } catch (error) {
    console.warn('[agent-launch-profile] Failed to persist pane profile registry:', error)
    try {
      rmSync(temporary, { force: true })
    } catch {}
  }
}

/** Records the profile a fresh spawn launched under; a reattach keeps the earlier record. */
export function recordPaneLaunchProfileForSpawn(args: {
  ptyId: string | undefined
  isReattach: boolean
  launchEnv: Record<string, string> | NodeJS.ProcessEnv | undefined
}): void {
  if (!args.ptyId || args.isReattach) {
    return
  }
  const profileId = agentLaunchProfileIdFromEnv(args.launchEnv)
  const registry = readRegistry()
  if (registry.panes[args.ptyId] === profileId || (!profileId && !registry.panes[args.ptyId])) {
    return
  }
  if (profileId) {
    registry.panes[args.ptyId] = profileId
    // Why: a crash mid-session would otherwise leak one entry per terminal forever.
    const overflow = Object.keys(registry.panes).length - MAX_TRACKED_PANES
    for (const staleId of Object.keys(registry.panes).slice(0, Math.max(0, overflow))) {
      delete registry.panes[staleId]
    }
  } else {
    delete registry.panes[args.ptyId]
  }
  writeRegistry(registry)
}

export function forgetPaneLaunchProfile(ptyId: string): void {
  const registry = readRegistry()
  if (!(ptyId in registry.panes)) {
    return
  }
  delete registry.panes[ptyId]
  writeRegistry(registry)
}

export function getPaneLaunchProfile(ptyId: string | null | undefined): string | undefined {
  return ptyId ? readRegistry().panes[ptyId] : undefined
}

export const _internals = {
  resetCache(): void {
    cached = null
  }
}
