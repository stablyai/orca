import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
} from '../../shared/claude-profile-routing'
import { WSL_CLAUDE_PROFILE_HELPER_FILENAME } from '../../shared/remote-bundle-artifacts'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import { getWslHomeAsync, listRunningWslDistrosAsync } from '../wsl'
import { ensureWslPinnedRuntime } from '../wsl/wsl-pinned-runtime'
import { relayBundleCandidates } from '../ssh/relay-bundle-paths'
import { runWslProcess, type WslSpec } from '../wsl/wsl-runner'
import { describeWslProcessFailure } from '../wsl/wsl-process-failure'
import { claudeProfileMarkerPath, type ClaudeProfileDescriptor } from './claude-profile-paths'
import type { ClaudeProfileRouterSettings } from './claude-profile-router'
import { claudeProfileMissing, claudeProfileSetupFailed } from './claude-profile-launch-errors'
import {
  isSameClaudeLogin,
  readClaudeFolderLoginAsync,
  type ClaudeFolderLogin
} from './claude-account-folder'
import { wslClaudeProfile, wslClaudeProfilePointer } from './claude-profile-wsl-paths'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import {
  findClaudeAccount,
  getClaudeWslSelectionKey,
  getSelectedClaudeAccountIdForTarget
} from './runtime-selection'

type WslSetup = (distro: string, guestHome: string, accountId: string) => Promise<void>

/** Route each distro through guest-owned profiles, history links, and selection pointers. */
export class ClaudeWslProfileRouter {
  private readonly setups = new Map<string, Promise<void>>()
  constructor(
    private readonly args: {
      getSettings: () => ClaudeProfileRouterSettings
      /** The host's data folder; it names the guest pointer per Orca build. */
      dataRoot: string
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

  /** Startup must not boot stopped distros. */
  async runningDistros(): Promise<string[]> {
    const running = await listRunningWslDistrosAsync({ requireConfirmed: true })
    return running.filter((distro) => this.accountIn(distro))
  }

  private async resolve(distro: string) {
    const home = parseWslUncPath((await getWslHomeAsync(distro)) ?? '')?.linuxPath
    if (!home?.startsWith('/')) {
      throw new Error(`Could not read the home folder of WSL distro ${distro}.`)
    }
    const selected = this.selectedProfile(home, distro)
    return { home, selected, profile: await this.routed(distro, home, selected) }
  }

  /** Reuse a matching guest System default login until the account signs in separately. */
  private async routed(
    distro: string,
    home: string,
    selected: ClaudeProfileDescriptor | null
  ): Promise<ClaudeProfileDescriptor | null> {
    if (!selected || (await guestLogin(distro, posix.join(selected.home, '.claude.json')))) {
      return selected
    }
    const saved = findClaudeAccount(this.args.getSettings(), selected.accountId)
    const systemDefault = await guestLogin(distro, posix.join(home, '.claude.json'))
    return saved && systemDefault && isSameClaudeLogin(saved, systemDefault) ? null : selected
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

  /** Publish the pointer before background setup; remove it when no accounts remain. */
  async publish(distro: string): Promise<void> {
    const { home, selected, profile } = await this.resolve(distro)
    if (!this.accountIn(distro)) {
      await runGuest(distro, {
        script: 'rm -f -- "$1"',
        args: [this.pointerIn(home)],
        loginPath: 'none'
      })
      return
    }
    await writePointer(distro, this.pointerIn(home), profile?.home ?? '')
    // Create missing or covered folders so the account can sign in separately.
    if (selected) {
      this.setUpInBackground(distro, home, selected.accountId)
    }
  }

  private setUpInBackground(distro: string, home: string, accountId: string): void {
    this.setUp(distro, home, accountId).catch((error: unknown) => {
      console.warn('[claude-profile] WSL account setup failed:', error)
    })
  }

  /** Wait for initial setup; later refreshes run in the background. */
  async prepareLaunch(distro: string): Promise<ClaudeRuntimeAuthPreparation> {
    const { home, profile } = await this.resolve(distro)
    if (profile && !(await hasMarker(distro, profile))) {
      await this.setUp(distro, home, profile.accountId).catch((error: unknown) => {
        console.warn('[claude-profile] WSL account setup failed:', error)
        throw claudeProfileSetupFailed()
      })
    } else if (profile) {
      // Starting guest Node for each refresh would delay launches.
      this.setUpInBackground(distro, home, profile.accountId)
    }
    // Re-read selection after setup so a concurrent switch cannot be overwritten by a stale pointer.
    if (this.accountIn(distro)) {
      const current = await this.routed(distro, home, this.selectedProfile(home, distro))
      await writePointer(distro, this.pointerIn(home), current?.home ?? '')
    }
    return this.preparationFor(distro, home, profile)
  }

  /** Compare pre-routing terminals against the selection; null means no account is selected. */
  async systemDefaultRunsAnotherAccount(distro: string): Promise<boolean | null> {
    const { home, selected } = await this.resolve(distro)
    if (!selected) {
      return null
    }
    const login =
      (await guestLogin(distro, posix.join(selected.home, '.claude.json'))) ??
      findClaudeAccount(this.args.getSettings(), selected.accountId)
    const systemDefault = await guestLogin(distro, posix.join(home, '.claude.json'))
    return !login || !systemDefault || !isSameClaudeLogin(login, systemDefault)
  }

  /** Read usage from the same guest login the account would launch with. */
  async accountUsagePreparation(
    distro: string,
    accountId: string
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const { home } = await this.resolve(distro)
    const { profile } = wslClaudeProfile(home, distro, accountId)
    return this.preparationFor(distro, home, await this.routed(distro, home, profile))
  }

  async preparation(distro: string): Promise<ClaudeRuntimeAuthPreparation> {
    const { home, profile } = await this.resolve(distro)
    await this.assertPresent(distro, profile)
    return this.preparationFor(distro, home, profile)
  }

  async prepareAccount(distro: string, accountId: string): Promise<string> {
    const { home } = await this.resolve(distro)
    const { profile } = wslClaudeProfile(home, distro, accountId)
    await this.setUp(distro, home, accountId).catch((error: unknown) => {
      console.warn('[claude-profile] WSL account setup failed:', error)
      throw new Error(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
    })
    return profile.home
  }

  /** Wait for setup so it cannot recreate the folder; guest rm preserves linked history. */
  async removeAccount(distro: string, accountId: string): Promise<void> {
    await this.setups.get(accountId)?.catch(() => {})
    const { home } = await this.resolve(distro)
    const folder = posix.dirname(wslClaudeProfile(home, distro, accountId).profile.home)
    await runGuest(distro, { script: 'rm -rf -- "$1"', args: [folder], loginPath: 'none' })
  }

  /** Falling back would run the wrong account. */
  private async assertPresent(distro: string, profile: ClaudeProfileDescriptor | null) {
    if (profile && !(await guestStat(distro, profile.home))?.isDirectory()) {
      throw claudeProfileMissing()
    }
  }

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
      provenance: profile ? `profile:${profile.accountId}:wsl:${distro}` : `wsl:${distro}:system`
    }
  }

  /** Reuse in-flight setup per account. */
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

function guestLogin(distro: string, stateFile: string): Promise<ClaudeFolderLogin | null> {
  return readClaudeFolderLoginAsync(toWindowsWslPath(stateFile, distro))
}

// Read over the share to avoid spawning a guest process for stats.
async function guestStat(distro: string, linuxPath: string) {
  return lstat(toWindowsWslPath(linuxPath, distro)).catch(() => null)
}

async function hasMarker(distro: string, profile: ClaudeProfileDescriptor): Promise<boolean> {
  return (await guestStat(distro, claudeProfileMarkerPath(profile)))?.isFile() ?? false
}

/** Read over the share first to avoid a guest process when the pointer is unchanged. */
async function writePointer(distro: string, pointer: string, home: string): Promise<void> {
  // Bound share reads so startup publication can fall back to a guest write.
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
    throw new Error(`WSL ${distro}: ${describeWslProcessFailure(result)}`)
  }
  return result.stdout.trim()
}

/** Run guest setup with the pinned Node runtime. */
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
  // Successful setup is silent; warnings produce a report and refusal exits nonzero.
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
