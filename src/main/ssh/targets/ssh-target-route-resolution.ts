import { createHash } from 'node:crypto'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConfigHost } from '../config/ssh-config-parser'
import {
  resolveWithSshG,
  runSshG,
  sshGArgsForHost,
  type SshResolvedConfig
} from '../config/ssh-g-config-resolution'
import { resolveEffectiveSshEndpoint } from '../connection/ssh-connect-config'
import { resolveEffectiveProxy } from '../ssh-proxy-command'
import { sshRouteKey, type SshRoute } from './ssh-target-identity'
import { mayUserSshConfigClaimAlias } from '../config/ssh-config-alias-claim'
import {
  appendSshTargetDestinationArgs,
  isOpenSshConfigBackedTarget
} from '../system-transport/system-ssh-args'

export type SshConfigResolver = (alias: string) => Promise<SshResolvedConfig | null>

// Few enough to not stall an import behind a slow config, and to not spawn a burst of ssh processes.
const RESOLVE_CONCURRENCY = 4

export type SshRouteResolvers = {
  /** `ssh -G <alias>`: what the ssh2 transport merges with the target's stored fields. */
  config?: SshConfigResolver
  /** `ssh -G` with system ssh's own destination args, so OpenSSH applies its precedence. */
  systemRoute?: (
    target: SshTarget,
    options: { aliasClaimedByConfig?: false }
  ) => Promise<SshResolvedConfig | null>
  /** Whether the user's config still has a Host block for the alias; the connection asks the same. */
  aliasClaimed?: (alias: string) => boolean
}

// System ssh runs without -F, so neither does this; -G only prints the route system ssh would take.
async function resolveSystemSshRoute(
  target: SshTarget,
  options: { aliasClaimedByConfig?: false }
): Promise<SshResolvedConfig | null> {
  const args = ['-G']
  appendSshTargetDestinationArgs(args, target, options)
  return runSshG(args)
}

function resolvedRouteProxy(resolved: SshResolvedConfig): SshRoute['proxy'] | null {
  if (resolved.proxyCommand && resolved.proxyJump) {
    return null
  }
  if (resolved.proxyCommand) {
    return { kind: 'proxy-command', command: resolved.proxyCommand }
  }
  return resolved.proxyJump ? { kind: 'jump-host', jumpHost: resolved.proxyJump } : undefined
}

// A target may connect through ssh2 or system ssh, which order host and proxy differently, so both must agree.
async function resolveRouteKey(target: SshTarget, resolvers: SshRouteResolvers): Promise<string> {
  // The connection resolves the same alias; without that answer the route is unknown, not alias-equal.
  const resolved = await (resolvers.config ?? resolveWithSshG)(
    target.configHost || target.label
  ).catch(() => null)
  // `%n` is the destination system ssh is given.
  const alias = target.configHost || target.host
  if (!resolved) {
    return ''
  }
  const ssh2Key = sshRouteKey(
    {
      alias,
      ...resolveEffectiveSshEndpoint(target, resolved),
      proxy: resolveEffectiveProxy(target, resolved)
    },
    'ssh2'
  )
  // An unclaimed alias makes system ssh restore the saved endpoint, as the connection does.
  const aliasClaimed = target.configHost
    ? (resolvers.aliasClaimed ?? mayUserSshConfigClaimAlias)(target.configHost)
    : true
  // A claimed config-backed target's system command is just the alias, which `resolved` already answers.
  // Reuse only when `ssh -G` read the config system ssh will: a divergent HOME adds -F.
  const sameConfigAsSystemSsh = !sshGArgsForHost(target.configHost || target.label).includes('-F')
  const system =
    Boolean(target.configHost) &&
    isOpenSshConfigBackedTarget(target) &&
    aliasClaimed &&
    sameConfigAsSystemSsh
      ? resolved
      : await (resolvers.systemRoute ?? resolveSystemSshRoute)(
          target,
          aliasClaimed ? {} : { aliasClaimedByConfig: false }
        ).catch(() => null)
  const systemProxy = system ? resolvedRouteProxy(system) : null
  if (!system || systemProxy === null) {
    return ''
  }
  const systemKey = sshRouteKey({
    alias,
    host: system.hostname,
    port: system.port,
    username: system.user ?? '',
    proxy: systemProxy
  })
  return ssh2Key === systemKey ? ssh2Key : ''
}

/** Route keys for each target, in order, at most four `ssh -G` at once; '' where the route is unknown. */
export async function resolveSshRouteKeys(
  targets: readonly SshTarget[],
  resolvers: SshRouteResolvers = {}
): Promise<string[]> {
  const keys: string[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const index = next++
      keys[index] = await resolveRouteKey(targets[index]!, resolvers).catch(() => '')
    }
  }
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, targets.length) }, worker))
  return keys
}

/** One import run's view: its config and which new aliases another target already routes to. */
export type SshRouteSnapshot = {
  /** Config text, targets' routing fields and tombstones the snapshot was built from. */
  fingerprint: string
  configHosts: SshConfigHost[]
  /** New alias → label of the existing target with the same route. */
  duplicateOf: ReadonlyMap<string, string>
  builtAt: number
}

export function sshRouteSnapshotFingerprint(input: {
  configText: string
  targets: readonly SshTarget[]
  deletedAliases: readonly string[]
}): string {
  const routing = input.targets.map((target) => [
    target.id,
    target.source,
    target.configHost,
    target.label,
    target.host,
    target.port,
    target.username,
    target.jumpHost,
    target.proxyCommand
  ])
  return createHash('sha256')
    .update(JSON.stringify([input.configText, routing, [...input.deletedAliases].sort()]))
    .digest('hex')
}

/** Insert candidates whose route an existing target already has, mapped to that target's label. */
export async function findSshRouteDuplicates(
  inserts: readonly { alias: string; candidate: SshTarget }[],
  existingTargets: readonly SshTarget[],
  resolvers?: SshRouteResolvers
): Promise<Map<string, string>> {
  const duplicates = new Map<string, string>()
  if (inserts.length === 0 || existingTargets.length === 0) {
    return duplicates
  }
  const keys = await resolveSshRouteKeys(
    // Resolve what would be inserted: a config target, which the connection resolves through ssh -G.
    [
      ...inserts.map(({ candidate }) => ({ ...candidate, source: 'ssh-config' as const })),
      ...existingTargets
    ],
    resolvers
  )
  const labelByRoute = new Map<string, string>()
  existingTargets.forEach((target, index) => {
    const key = keys[inserts.length + index]
    if (key && !labelByRoute.has(key)) {
      labelByRoute.set(key, target.label)
    }
  })
  inserts.forEach(({ alias }, index) => {
    const label = keys[index] ? labelByRoute.get(keys[index]!) : undefined
    if (label !== undefined) {
      duplicates.set(alias, label)
    }
  })
  return duplicates
}
