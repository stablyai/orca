import { posix } from 'node:path'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import {
  CLAUDE_PROFILE_ROUTING_CAPABILITY,
  WSL_CLAUDE_PROFILE_POINTER
} from '../../shared/claude-profile-routing'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { describeClaudeProfile } from './claude-profile-paths'
import type {
  ClaudeProfileHostAccess,
  ClaudeProfileRoutingOwner
} from './claude-profile-routing-owner'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import {
  prepareClaudeWslGuest,
  waitForRunningWslDistro,
  withdrawClaudeWslPointer,
  type ClaudeWslGuest,
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
  prepareGuest: (
    distro: string,
    access?: ClaudeProfileHostAccess
  ) => Promise<ClaudeWslGuest> = prepareClaudeWslGuest,
  withdrawPointer: (
    distro: string,
    access?: ClaudeProfileHostAccess
  ) => Promise<void> = withdrawClaudeWslPointer,
  waitForRunning: (distro: string) => Promise<boolean> = waitForRunningWslDistro
): ClaudeProfileRoutingOwner {
  const guests = new Map<string, { guest: ClaudeWslGuest; expires: number }>()
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
  const selectedAccountId = (target?: ClaudeAccountSelectionTarget) => {
    try {
      return selected(target).accountId
    } catch {
      return undefined
    }
  }
  const owner: ClaudeProfileRoutingOwner = {
    refresh: async (target, access) => {
      const { distro, accountId } = selected(target)
      const key = distro.toLowerCase()
      const cached = guests.get(key)
      const guest =
        cached && cached.expires > Date.now() ? cached.guest : await prepareGuest(distro, access)
      if (guest !== cached?.guest) {
        guests.set(key, { guest, expires: Date.now() + 600_000 })
      }
      const result = await guest.request(
        { action: 'inspect', distro, accountId, userHome: guest.home, hooksEnabled: false },
        access
      )
      // Why: an inspect that lands after a newer selection must not replace its verification.
      if (selectedAccountId(target) === accountId) {
        inspections.set(key, { accountId, home: guest.home, result })
      }
      if (!result.ready) {
        throw new Error('Selected WSL Claude account needs a fresh sign-in')
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
    readiness: (accountId) => {
      const account = settings().claudeManagedAccounts.find((entry) => entry.id === accountId)
      const inspection = account?.wslDistro
        ? inspections.get(account.wslDistro.toLowerCase())
        : undefined
      try {
        return inspection &&
          account?.wslDistro &&
          inspection.result.homes?.includes(
            profileFor(inspection.home, accountId, account.wslDistro).home
          )
          ? 'ready'
          : 'sign-in-required'
      } catch {
        return 'sign-in-required'
      }
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
    withdraw: async (target, access) => {
      const distro = distroFor(target)
      guests.delete(distro.toLowerCase())
      inspections.delete(distro.toLowerCase())
      await withdrawPointer(distro, access)
    }
  }
  return owner
}

export function withWslClaudeProfileOwner(
  native: ClaudeProfileRoutingOwner,
  wsl: ClaudeProfileRoutingOwner,
  settings: () => ClaudeProfileSettings
): ClaudeProfileRoutingOwner {
  const forTarget = (target?: ClaudeAccountSelectionTarget) =>
    target?.runtime === 'wsl' ? wsl : native
  return {
    refresh: (target, access) => forTarget(target).refresh?.(target, access) ?? Promise.resolve(),
    resolve: (target) => forTarget(target).resolve(target),
    pointerPath: (target) => forTarget(target).pointerPath(target),
    targets: () => [...native.targets(), ...wsl.targets()],
    readHomes: (target, surface) =>
      target
        ? forTarget(target).readHomes(target, surface)
        : [...native.readHomes(undefined, surface), ...wsl.readHomes(undefined, surface)],
    capabilities: (target) => forTarget(target).capabilities(target),
    isProvisioned: (descriptor) => forTarget(descriptor.target).isProvisioned(descriptor),
    readiness: (id) =>
      (settings().claudeManagedAccounts.find((account) => account.id === id)?.managedAuthRuntime ===
      'wsl'
        ? wsl
        : native
      ).readiness(id),
    prepare: (descriptor, access) => forTarget(descriptor.target).prepare(descriptor, access),
    trust: (descriptor, workspace, access) =>
      forTarget(descriptor.target).trust?.(descriptor, workspace, access) ?? Promise.resolve(),
    publish: (descriptor, access) => forTarget(descriptor.target).publish(descriptor, access),
    withdraw: (target, access) => forTarget(target).withdraw(target, access),
    reachable: (target) => forTarget(target).reachable?.(target) ?? Promise.resolve(true)
  }
}
