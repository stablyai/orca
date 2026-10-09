import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { CLAUDE_PROFILE_POINTER_ENV } from '../../shared/claude-profile-routing'
import { WSL_CLAUDE_PROFILE_HELPER_FILENAME } from '../../shared/relay-artifacts'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import { getWslHomeAsync, listRunningWslDistrosAsync } from '../wsl'
import { ensureWslPinnedRuntime } from '../wsl/wsl-pinned-runtime'
import { relayBundleCandidates } from '../ssh/relay-bundle-paths'
import { runWslProcess, type WslSpec } from '../wsl/wsl-runner'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  claudeProfileMarkerPath,
  type ClaudeProfileDescriptor
} from './claude-profile-paths'
import {
  CLAUDE_PROFILE_MISSING_MESSAGE,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE,
  type ClaudeProfileRouterSettings
} from './claude-profile-router'
import { wslClaudeProfile, wslClaudeProfilePointer } from './claude-profile-wsl-paths'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import { getClaudeWslSelectionKey, getSelectedClaudeAccountIdForTarget } from './runtime-selection'

type WslSetup = (distro: string, guestHome: string, accountId: string) => Promise<void>

/**
 * The host router's rules for one WSL distro: account folders, setup and the which-account file
 * all live in the guest, so links are Linux links and history shares within the guest.
 */
export class ClaudeWslProfileRouter {
  private readonly setups = new Map<string, Promise<void>>()
  constructor(
    private readonly args: {
      getSettings: () => ClaudeProfileRouterSettings
      /** The host's data folder; it names the guest pointer per Orca build. */
      dataRoot: string
      /** Tests replace the guest helper. */
      runSetup?: WslSetup
    }
  ) {}

  private accountIn(distro: string): boolean {
    const key = getClaudeWslSelectionKey(distro)
    return this.args
      .getSettings()
      .claudeManagedAccounts.some(
        (account) =>
          account.managedAuthRuntime === 'wsl' &&
          getClaudeWslSelectionKey(account.wslDistro) === key
      )
  }

  /** Running distros that hold an Orca account; startup must not boot a stopped one. */
  async runningDistros(): Promise<string[]> {
    const running = await listRunningWslDistrosAsync({ requireConfirmed: true })
    return running.filter((distro) => this.accountIn(distro))
  }

  private async resolve(distro: string) {
    const home = parseWslUncPath((await getWslHomeAsync(distro)) ?? '')?.linuxPath
    if (!home?.startsWith('/')) {
      throw new Error(`Could not read the home folder of WSL distro ${distro}.`)
    }
    return { home, profile: this.selectedProfile(home, distro) }
  }

  private selectedProfile(home: string, distro: string): ClaudeProfileDescriptor | null {
    const id = getSelectedClaudeAccountIdForTarget(this.args.getSettings(), {
      runtime: 'wsl',
      wslDistro: distro
    })
    return id ? wslClaudeProfile(home, distro, id).profile : null
  }

  private pointerIn(home: string): string {
    return posix.join(home, wslClaudeProfilePointer(this.args.dataRoot))
  }

  /** Pointer first, then setup in the background, as on the host. No accounts here means no pointer. */
  async publish(distro: string): Promise<void> {
    const { home, profile } = await this.resolve(distro)
    if (!this.accountIn(distro)) {
      await runGuest(distro, {
        script: 'rm -f -- "$1"',
        args: [this.pointerIn(home)],
        loginPath: 'none'
      })
      return
    }
    await writePointer(distro, this.pointerIn(home), profile?.home ?? '')
    // Why the existence check: setup creates the folder, and only sign-in may create an account.
    if (profile && (await guestStat(distro, profile.home))?.isDirectory()) {
      this.setUp(distro, home, profile.accountId).catch((error: unknown) => {
        console.warn('[claude-profile] WSL account setup failed:', error)
      })
    }
  }

  /** Waits for setup only for a folder that was never set up; otherwise launches at once. */
  async prepareLaunch(distro: string): Promise<ClaudeRuntimeAuthPreparation> {
    const { home, profile } = await this.resolve(distro)
    await this.assertPresent(distro, profile)
    if (profile && !(await guestStat(distro, claudeProfileMarkerPath(profile)))?.isFile()) {
      await this.setUp(distro, home, profile.accountId).catch((error: unknown) => {
        console.warn('[claude-profile] WSL account setup failed:', error)
        throw new Error(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
      })
    }
    // Why: a missing or stale guest pointer would run the pane's `claude` under another account.
    // Re-read the selection: one made during setup has already published its own pointer.
    if (this.accountIn(distro)) {
      const selected = this.selectedProfile(home, distro)
      await writePointer(distro, this.pointerIn(home), selected?.home ?? '')
    }
    return this.preparationFor(distro, home, profile)
  }

  async preparation(distro: string): Promise<ClaudeRuntimeAuthPreparation> {
    const { home, profile } = await this.resolve(distro)
    await this.assertPresent(distro, profile)
    return this.preparationFor(distro, home, profile)
  }

  /** Falling back would run the wrong account. */
  private async assertPresent(distro: string, profile: ClaudeProfileDescriptor | null) {
    if (profile && !(await guestStat(distro, profile.home))?.isDirectory()) {
      throw new Error(CLAUDE_PROFILE_MISSING_MESSAGE)
    }
  }

  /** The shape main's WSL account path returns, so trust and rate limits need nothing new. */
  private preparationFor(
    distro: string,
    home: string,
    profile: ClaudeProfileDescriptor | null
  ): ClaudeRuntimeAuthPreparation {
    const configHome = profile?.home ?? posix.join(home, '.claude')
    return {
      configDir: toWindowsWslPath(configHome, distro),
      runtime: 'wsl',
      wslDistro: distro,
      wslLinuxConfigDir: configHome,
      envPatch: {
        [CLAUDE_PROFILE_POINTER_ENV]: `~/${wslClaudeProfilePointer(this.args.dataRoot)}`,
        ...(profile
          ? { CLAUDE_CONFIG_DIR: profile.home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: profile.home }
          : {})
      },
      stripAuthEnv: true,
      provenance: profile ? `profile:${profile.accountId}:wsl:${distro}` : `wsl:${distro}:system`
    }
  }

  /** One setup per account at a time; a later request reuses the running one. */
  private setUp(distro: string, home: string, accountId: string): Promise<void> {
    const running = this.setups.get(accountId)
    if (running) {
      return running
    }
    const run = (this.args.runSetup ?? runWslSetup)(distro, home, accountId).finally(() =>
      this.setups.delete(accountId)
    )
    this.setups.set(accountId, run)
    return run
  }
}

// Why over the distro's share: a launch must not wait on a guest process for two stats.
async function guestStat(distro: string, linuxPath: string) {
  return lstat(toWindowsWslPath(linuxPath, distro)).catch(() => null)
}

/** Writes in the guest only when the file differs, so a launch reads it over the share instead. */
async function writePointer(distro: string, pointer: string, home: string): Promise<void> {
  // Why the timeout: a hung share must not stall startup's serialized publish; the guest write decides.
  const current = await Promise.race([
    readFile(toWindowsWslPath(pointer, distro), 'utf8').catch(() => null),
    new Promise<null>((resolve) => setTimeout(resolve, 2_000, null).unref())
  ])
  if (current === home) {
    return
  }
  await runGuest(distro, {
    script:
      'umask 077; mkdir -p -- "${1%/*}" && printf %s "$2" > "$1.tmp" && mv -f -- "$1.tmp" "$1"',
    args: [pointer, home],
    loginPath: 'none'
  })
}

async function runGuest(distro: string, spec: WslSpec, timeoutMs = 15_000): Promise<string> {
  const result = await runWslProcess({ ...spec, distro, timeoutMs, maxOutputBytes: 256 * 1024 })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `WSL ${distro}: ${result.stderr.trim() || (result.timedOut ? 'timed out' : 'command failed')}`
    )
  }
  return result.stdout.trim()
}

/** Step 1's setup, run as Linux inside the distro on Orca's pinned Node. */
const runWslSetup: WslSetup = async (distro, home, accountId) => {
  const helper = relayBundleCandidates('wsl')
    .map((dir) => join(dir, WSL_CLAUDE_PROFILE_HELPER_FILENAME))
    .find(existsSync)
  if (!helper) {
    throw new Error('The bundled WSL Claude account helper is missing. Reinstall Orca.')
  }
  const run = (spec: WslSpec, timeoutMs?: number) => runGuest(distro, spec, timeoutMs)
  const node = await ensureWslPinnedRuntime(
    run,
    join(getAppEnvironment().getPath('userData'), 'orcad-artifacts'),
    AbortSignal.timeout(180_000)
  )
  const guestHelper = await run({
    program: 'wslpath',
    args: ['-a', '-u', helper],
    loginPath: 'none'
  })
  // Prints its report only when setup was incomplete; a refusal exits non-zero.
  const report = await run(
    {
      program: '/usr/bin/env',
      args: ['-u', 'NODE_OPTIONS', node, guestHelper, home, distro, accountId],
      loginPath: 'none'
    },
    120_000
  )
  if (report) {
    console.warn('[claude-profile] WSL account setup was incomplete:', report)
  }
}
