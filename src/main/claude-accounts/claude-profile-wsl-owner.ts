import { prepareClaudeWslDefaultGuest } from './claude-profile-wsl-default'
import { inspectClaudeWslGuest, type ClaudeWslGuestCache } from './claude-profile-wsl-inspect'
import { posix } from 'node:path'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import {
  CLAUDE_PROFILE_ROUTING_CAPABILITY,
  WSL_CLAUDE_PROFILE_POINTER
} from '../../shared/claude-profile-routing'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { describeClaudeProfile } from './claude-profile-paths'
import {
  ClaudeProfileSignInRequiredError,
  type ClaudeProfileRoutingOwner
} from './claude-profile-routing-owner'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import {
  prepareClaudeWslGuest,
  waitForRunningWslDistro,
  withdrawClaudeWslPointer,
  type ClaudeWslProfileResponse
} from './claude-profile-wsl-transport'

export type ClaudeProfileSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
  | 'agentStatusHooksEnabled'
  | 'disabledTuiAgents'
>

export function createWslClaudeProfileOwner(
  settings: () => ClaudeProfileSettings,
  prepareGuest: typeof prepareClaudeWslGuest = prepareClaudeWslGuest,
  withdrawPointer: typeof withdrawClaudeWslPointer = withdrawClaudeWslPointer,
  waitForRunning: (distro: string) => Promise<boolean> = waitForRunningWslDistro,
  prepareDefault: typeof prepareClaudeWslDefaultGuest = prepareClaudeWslDefaultGuest
): ClaudeProfileRoutingOwner {
  // Why: a managed guest that failed to start is not retried for System Default until it expires
  // or the user acts; each retry could wait out the full prepare timeout first.
  const managedGuestFailures = new Map<string, number>()
  const guests: ClaudeWslGuestCache = new Map()
  const inspections = new Map<
    string,
    { accountId: string | null; home: string; result: ClaudeWslProfileResponse }
  >()
  const distroFor = (target?: ClaudeAccountSelectionTarget) => {
    const distro = target?.wslDistro?.trim()
    if (!distro) {
      throw new Error('Claude profile requires a specific WSL distro')
    }
    return (
      settings().claudeManagedAccounts.find(
        (account) => account.wslDistro?.toLowerCase() === distro.toLowerCase()
      )?.wslDistro ?? distro
    )
  }
  const selected = (target?: ClaudeAccountSelectionTarget) => {
    const distro = distroFor(target)
    const accountId = getSelectedClaudeAccountIdForTarget(settings(), {
      runtime: 'wsl',
      wslDistro: distro
    })
    const account = settings().claudeManagedAccounts.find((entry) => entry.id === accountId)
    if (
      accountId &&
      (!account ||
        account.managedAuthRuntime !== 'wsl' ||
        account.wslDistro?.toLowerCase() !== distro.toLowerCase())
    ) {
      throw new Error('Claude account does not belong to this WSL distro')
    }
    return { distro, accountId }
  }
  const guestFor = (distro: string) => {
    const guest = guests.get(distro.toLowerCase())
    if (!guest) {
      throw new Error(`WSL distro ${distro} has not provided its Claude profile paths`)
    }
    return guest.guest
  }
  const profileFor = (home: string, accountId: string, distro: string) =>
    describeClaudeProfile(posix.join(home, '.local/share/orca'), accountId, {
      executionHostId: 'local',
      runtime: 'wsl',
      distro
    })
  const inspectionFor = (accountId: string) => {
    const distro = settings().claudeManagedAccounts.find(
      (entry) => entry.id === accountId
    )?.wslDistro
    return distro ? inspections.get(distro.toLowerCase()) : undefined
  }
  const selectedAccountId = (target?: ClaudeAccountSelectionTarget) => {
    try {
      return selected(target).accountId
    } catch {
      return undefined
    }
  }
  const owner: ClaudeProfileRoutingOwner = {
    refresh: async (target, access, options) => {
      const { distro, accountId } = selected(target)
      const key = distro.toLowerCase()
      const previous = inspections.get(key)
      try {
        const managed = settings().claudeManagedAccounts.some(
          (entry) => entry.managedAuthRuntime === 'wsl' && entry.wslDistro?.toLowerCase() === key
        )
        const { guest, result } = await inspectClaudeWslGuest({
          guests,
          managedGuestFailures,
          prepareGuest,
          prepareDefault,
          distro,
          managed,
          accountId,
          requireManaged: options?.managedGuest,
          accountIds: settings()
            .claudeManagedAccounts.filter((entry) => entry.wslDistro?.toLowerCase() === key)
            .map((entry) => entry.id),
          access
        })
        // Why: an inspect that lands after a newer selection must not replace its verification.
        if (selectedAccountId(target) === accountId) {
          inspections.set(key, { accountId, home: guest.home, result })
        }
        if (!result.ready) {
          throw accountId && result.readiness?.[accountId] === 'sign-in-required'
            ? new ClaudeProfileSignInRequiredError()
            : new Error('Selected WSL Claude account could not be checked')
        }
      } catch (error) {
        if (inspections.get(key) === previous) {
          inspections.delete(key)
        }
        throw error
      }
    },
    resolve(target) {
      const { distro, accountId } = selected(target)
      const inspected = inspections.get(distro.toLowerCase())
      if (inspected?.accountId !== accountId || !inspected.result.ready) {
        throw new Error('WSL Claude profile is not verified')
      }
      const profile = accountId ? profileFor(inspected.home, accountId, distro) : null
      const defaultHome = posix.join(inspected.home, '.claude')
      return {
        profile,
        configHome: profile?.home ?? defaultHome,
        readHome: toWindowsWslUncPath(profile?.home ?? defaultHome, distro),
        defaultHome,
        pointerPath: owner.pointerPath(target),
        target: { runtime: 'wsl', wslDistro: distro }
      }
    },
    // Why guest-relative: the claude function expands it, so a pane needs no guest home.
    pointerPath: () => WSL_CLAUDE_PROFILE_POINTER,
    // Settings only, as Step 3 had it: a distro stops being routed once its last account goes.
    targets: () =>
      [
        ...new Set(
          settings().claudeManagedAccounts.flatMap((account) =>
            account.managedAuthRuntime === 'wsl' && account.wslDistro ? [account.wslDistro] : []
          )
        )
      ].map((wslDistro) => ({ runtime: 'wsl', wslDistro })),
    capabilities: () => [CLAUDE_PROFILE_ROUTING_CAPABILITY],
    readHomes: (target, surface) => {
      if (target) {
        const distro = distroFor(target)
        const inspected = inspections.get(distro.toLowerCase())?.result
        return ((surface ? inspected?.historyHomes?.[surface] : inspected?.homes) ?? []).map(
          (home) => toWindowsWslUncPath(home, distro)
        )
      }
      return owner.targets().flatMap((entry) => owner.readHomes(entry, surface))
    },
    isProvisioned: ({ target }) =>
      inspections.get(distroFor(target).toLowerCase())?.result.provisioned ?? false,
    // Why per account: the guest's inspect lists every owned profile, not only the selected one.
    accountHome: (accountId) => {
      const account = settings().claudeManagedAccounts.find((entry) => entry.id === accountId)
      if (!account?.wslDistro) {
        throw new Error('Claude profile distro is unavailable.')
      }
      return toWindowsWslUncPath(
        profileFor(guestFor(account.wslDistro).home, accountId, account.wslDistro).home,
        account.wslDistro
      )
    },
    profileState: (accountId) => {
      const inspection = inspectionFor(accountId)
      return inspection
        ? {
            readiness: inspection.result.readiness?.[accountId] ?? 'unavailable',
            identity: inspection.result.identities?.[accountId] ?? null
          }
        : { readiness: 'unverified', identity: null }
    },
    prepare: async (descriptor, access) => {
      const distro = distroFor(descriptor.target)
      const guest = guestFor(distro)
      const result = await guest.request(
        {
          action: 'setup',
          distro,
          userHome: guest.home,
          accountId: descriptor.profile?.accountId ?? null,
          hooksEnabled: isAgentStatusHooksEnabledForAgent(settings(), 'claude')
        },
        access
      )
      if (!result.report) {
        throw new Error('WSL profile helper did not report setup')
      }
      const accountId = descriptor.profile?.accountId ?? null
      // Why: same guard as refresh; a late setup must not replace a newer selection's verification.
      if (selectedAccountId(descriptor.target) === accountId) {
        inspections.set(distro.toLowerCase(), {
          accountId,
          home: guest.home,
          result: {
            ...result,
            readiness: inspections.get(distro.toLowerCase())?.result.readiness,
            identities: inspections.get(distro.toLowerCase())?.result.identities,
            homes: inspections.get(distro.toLowerCase())?.result.homes,
            historyHomes: inspections.get(distro.toLowerCase())?.result.historyHomes
          }
        })
      }
      return result.report
    },
    trust: async ({ target, profile }, workspacePath, access) => {
      const distro = distroFor(target)
      const guest = guestFor(distro)
      await guest.request(
        {
          action: 'trust',
          distro,
          userHome: guest.home,
          accountId: profile?.accountId ?? null,
          hooksEnabled: false,
          workspacePath
        },
        access
      )
    },
    publish: async ({ target, profile }, access) => {
      const distro = distroFor(target)
      const guest = guestFor(distro)
      await guest.request(
        {
          action: 'publish',
          distro,
          userHome: guest.home,
          accountId: profile?.accountId ?? null,
          hooksEnabled: false
        },
        access
      )
    },
    reachable: (target) => waitForRunning(distroFor(target)),
    // Why publish, not remove: panes opened while the distro was routed keep reading this
    // pointer, and an empty one runs System Default there instead of refusing every `claude`.
    retire: async (target, access) => {
      const distro = distroFor(target)
      guests.delete(distro.toLowerCase())
      inspections.delete(distro.toLowerCase())
      const guest = await prepareDefault(distro, access)
      await guest.request(
        { action: 'publish', distro, userHome: guest.home, accountId: null, hooksEnabled: false },
        access
      )
    },
    withdraw: async (target, access) => {
      const distro = distroFor(target)
      guests.delete(distro.toLowerCase())
      // Why keep a not-ready inspection: it cannot verify a launch, but it still tells the
      // account rows why (e.g. an upgraded account needs sign-in) instead of "not checked".
      if (inspections.get(distro.toLowerCase())?.result.ready !== false) {
        inspections.delete(distro.toLowerCase())
      }
      await withdrawPointer(distro, access)
    }
  }
  return owner
}

export { withWslClaudeProfileOwner } from './claude-profile-host-owner'
