import { createWslClaudeProfileOwner } from './claude-profile-wsl-owner'
import { homedir } from 'node:os'
import { resolveClaudeCommand } from '../codex-cli/command'
import { getAppEnvironment } from '../../shared/app-environment'
import { claudeProfileRoutingEnabled } from '../../shared/claude-profile-routing'
import {
  createNativeClaudeProfileRouting,
  inheritedClaudeConfigDir
} from './claude-profile-native-owner'
import {
  installClaudeProfileRoutingAuthority,
  getClaudeProfileRoutingAuthority
} from './claude-profile-routing-authority'
import { probeClaudeCliVersionCached } from '../claude/claude-hook-event-versions'
import type { Store } from '../persistence'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import {
  ClaudeProfileSignInRequiredError,
  type ClaudeProfileHostAccess
} from './claude-profile-routing-owner'
import { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import { ClaudeRuntimePathResolver } from './runtime-paths'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { join } from 'node:path'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export class ClaudeRuntimeAuthService {
  private mutationQueue: Promise<unknown> = Promise.resolve()
  constructor(private readonly store: Pick<Store, 'getSettings'>) {
    if (claudeProfileRoutingEnabled()) {
      installClaudeProfileRoutingAuthority(
        createNativeClaudeProfileRouting({
          store,
          wsl:
            process.platform === 'win32'
              ? createWslClaudeProfileOwner(() => store.getSettings())
              : undefined,
          dataRoot: getAppEnvironment().getPath('userData'),
          userHome: homedir(),
          inheritedConfigDir: () => inheritedClaudeConfigDir(process.env),
          claudeVersion: () => probeClaudeCliVersionCached(resolveClaudeCommand())
        })
      )
    }
    void this.safeSyncForCurrentSelection()
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = resolveWslDefaultTarget(
      target ?? this.getDefaultAccountSelectionTarget()
    )
    const profiles = getClaudeProfileRoutingAuthority()
    if (profiles) {
      // Why: an unrouted WSL distro launches System Default with no guest call, as before profiles.
      return profiles.routes(effectiveTarget)
        ? profiles.prepare(effectiveTarget)
        : this.getPreparation(effectiveTarget)
    }
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effective = resolveWslDefaultTarget(target ?? this.getDefaultAccountSelectionTarget())
    try {
      const profiles = getClaudeProfileRoutingAuthority()
      if (!profiles) {
        throw new Error('Claude profile host is unavailable.')
      }
      if (!profiles.routes(effective)) {
        return this.getPreparation(effective)
      }
      await profiles.refreshForRead(effective)
      return profiles.preparation(profiles.resolve(effective))
    } catch (error) {
      return {
        configDir: '',
        envPatch: {},
        stripAuthEnv: true,
        provenance: `profile:${getSelectedClaudeAccountIdForTarget(this.store.getSettings(), effective) ?? 'system'}`,
        profileIssue: error instanceof Error ? error.message : 'Claude usage is unavailable.',
        profileIssueKind:
          error instanceof ClaudeProfileSignInRequiredError ? 'sign-in-required' : 'unavailable'
      }
    }
  }

  /** `access: 'boot'` marks a user's select or remove, which may start a stopped WSL distro. */
  async syncForCurrentSelection(
    target?: ClaudeAccountSelectionTarget,
    access: ClaudeProfileHostAccess = 'if-running'
  ): Promise<void> {
    await this.serializeMutation(async () => {
      const effectiveTarget = resolveWslDefaultTarget(
        target ?? this.getDefaultAccountSelectionTarget()
      )
      const profiles = getClaudeProfileRoutingAuthority()
      if (!profiles) {
        throw new Error('Claude profile routing is unavailable.')
      } else if (profiles.routes(effectiveTarget)) {
        await profiles.publish(effectiveTarget, 'always', access)
      } else {
        await profiles.retire(effectiveTarget, access)
      }
    })
  }

  /** With profiles, `target` limits the republish to the target whose change failed. */
  async forceMaterializeCurrentSelectionForRollback(
    target?: ClaudeAccountSelectionTarget
  ): Promise<void> {
    await this.serializeMutation(async () => {
      const profiles = getClaudeProfileRoutingAuthority()
      if (profiles) {
        if (!target) {
          await profiles.startup()
        } else if (profiles.routes(target)) {
          // Why boot: this undoes a user's failed select or remove.
          await profiles.publish(target, 'always', 'boot')
        }
        return
      }
      throw new Error('Claude profile routing is unavailable.')
    })
  }

  getRuntimeConfigDir(target?: ClaudeAccountSelectionTarget): string {
    const legacy = () => new ClaudeRuntimePathResolver().getRuntimePaths().configDir
    return (
      getClaudeProfileRoutingAuthority()?.configDirOr(
        target && resolveWslDefaultTarget(target),
        legacy
      ) ?? legacy()
    )
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      const profiles = getClaudeProfileRoutingAuthority()
      await (profiles ? profiles.startup() : this.syncForCurrentSelection())
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to sync runtime auth state:', error)
    }
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  private getDefaultAccountSelectionTarget(): ClaudeAccountSelectionTarget {
    const target = resolveLocalAccountRuntimeTarget(this.store.getSettings())
    return process.platform === 'win32' ? target : { runtime: 'host' }
  }

  private getPreparation(target?: ClaudeAccountSelectionTarget): ClaudeRuntimeAuthPreparation {
    const effective = target ?? this.getDefaultAccountSelectionTarget()
    if (getSelectedClaudeAccountIdForTarget(this.store.getSettings(), effective)) {
      throw new ClaudeProfileSignInRequiredError()
    }
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()
    if (effective.runtime === 'wsl') {
      const distro = effective.wslDistro ?? getDefaultWslDistro()
      const home = distro ? getWslHome(distro) : null
      const guest = home ? parseWslUncPath(home) : null
      if (!home || !guest) {
        throw new Error('WSL Claude home is unavailable.')
      }
      return {
        configDir: join(home, '.claude'),
        runtime: 'wsl',
        wslDistro: distro,
        wslLinuxConfigDir: `${guest.linuxPath.replace(/\/$/, '')}/.claude`,
        envPatch: {},
        stripAuthEnv: true,
        provenance: 'system'
      }
    }
    return {
      configDir: paths.configDir,
      runtime: 'host',
      envPatch: paths.envPatch,
      stripAuthEnv: false,
      provenance: 'system'
    }
  }
}

/** A WSL target that names no distro means the default distro, as Claude launches it there. */
function resolveWslDefaultTarget(
  target: ClaudeAccountSelectionTarget
): ClaudeAccountSelectionTarget {
  if (target.runtime !== 'wsl' || target.wslDistro?.trim()) {
    return target
  }
  const defaultDistro = getDefaultWslDistro()
  return defaultDistro ? { runtime: 'wsl', wslDistro: defaultDistro } : target
}
