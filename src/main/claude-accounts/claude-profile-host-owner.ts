import type { ClaudeProfileRoutingOwner } from './claude-profile-routing-owner'
import type { ClaudeProfileSettings } from './claude-profile-wsl-owner'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'

export function withWslClaudeProfileOwner(
  native: ClaudeProfileRoutingOwner,
  wsl: ClaudeProfileRoutingOwner,
  settings: () => ClaudeProfileSettings
): ClaudeProfileRoutingOwner {
  const forTarget = (target?: ClaudeAccountSelectionTarget) =>
    target?.runtime === 'wsl' ? wsl : native
  const ownerOf = (id: string) =>
    settings().claudeManagedAccounts.find((account) => account.id === id)?.managedAuthRuntime ===
    'wsl'
      ? wsl
      : native
  return {
    refresh: (target, access, options) =>
      forTarget(target).refresh?.(target, access, options) ?? Promise.resolve(),
    resolve: (target) => forTarget(target).resolve(target),
    pointerPath: (target) => forTarget(target).pointerPath(target),
    targets: () => [...native.targets(), ...wsl.targets()],
    readHomes: (target, surface) =>
      target
        ? forTarget(target).readHomes(target, surface)
        : [...native.readHomes(undefined, surface), ...wsl.readHomes(undefined, surface)],
    capabilities: (target) => forTarget(target).capabilities(target),
    isProvisioned: (descriptor) => forTarget(descriptor.target).isProvisioned(descriptor),
    accountHome: (id) => {
      const account = settings().claudeManagedAccounts.find((entry) => entry.id === id)
      const home = (account?.managedAuthRuntime === 'wsl' ? wsl : native).accountHome?.(id)
      if (!home) {
        throw new Error('Claude profile home is unavailable.')
      }
      return home
    },
    profileState: (id) => ownerOf(id).profileState(id),
    systemDefaultIdentity: () => native.systemDefaultIdentity?.() ?? null,
    prepare: (descriptor, access) => forTarget(descriptor.target).prepare(descriptor, access),
    trust: (descriptor, workspace, access) =>
      forTarget(descriptor.target).trust?.(descriptor, workspace, access) ?? Promise.resolve(),
    publish: (descriptor, access) => forTarget(descriptor.target).publish(descriptor, access),
    withdraw: (target, access) => forTarget(target).withdraw(target, access),
    retire: async (target, access) => {
      const owner = forTarget(target)
      await (owner.retire ? owner.retire(target, access) : owner.withdraw(target, access))
    },
    reachable: (target) => forTarget(target).reachable?.(target) ?? Promise.resolve(true)
  }
}
