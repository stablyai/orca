import { z } from 'zod'
import type { ExecutionHostHealth } from '../../../src/shared/execution-host-health'
import { parseExecutionHostId } from '../../../src/shared/execution-host'
import {
  MOBILE_RELAY_HOST_SLEEP_WORKTREE_METHOD,
  MOBILE_RELAY_HOST_WAKE_SLEEPING_AGENTS_METHOD,
  MOBILE_RELAY_HOST_WORKTREES_METHOD,
  MOBILE_RELAY_HOSTS_LIST_METHOD,
  type MobileRelayHost,
  type MobileRelayHostRelay
} from '../../../src/shared/mobile-relay-hosts-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

const HEALTH = [
  'local',
  'available',
  'connecting',
  'blocked',
  'disconnected',
  'error'
] as const satisfies readonly ExecutionHostHealth[]
const RELAY = [
  'ready',
  'update-needed',
  'unavailable'
] as const satisfies readonly MobileRelayHostRelay[]

const runtimeHostIdSchema = z.custom<`runtime:${string}`>(
  (value) => typeof value === 'string' && parseExecutionHostId(value)?.kind === 'runtime'
)

// Why the fallbacks: an arm a newer desktop adds must not drop its server from the list.
const relayHostSchema = z.looseObject({
  hostId: runtimeHostIdSchema,
  label: z.string(),
  health: z.enum(HEALTH).catch('error'),
  relay: z.enum(RELAY).catch('unavailable')
}) satisfies z.ZodType<MobileRelayHost>

/** The servers the paired desktop shows; a malformed entry is skipped, not the whole list. */
export const relayHostsListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'mobileRelay.hosts-or-skip',
    method: MOBILE_RELAY_HOSTS_LIST_METHOD,
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'relay-hosts',
      z.looseObject({ hosts: z.array(z.unknown()) }).transform(({ hosts }) =>
        hosts.flatMap((host) => {
          const parsed = relayHostSchema.safeParse(host)
          return parsed.success ? [parsed.data] : []
        })
      )
    )
  })
)

/** A server's rows as the desktop last fetched them; `worktrees: null` means none yet. */
export const relayHostWorktreesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'mobileRelay.host-worktrees-or-skip',
    method: MOBILE_RELAY_HOST_WORKTREES_METHOD,
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'relay-host-worktrees',
      z.looseObject({
        worktrees: z.array(z.unknown()).nullable(),
        stale: z.boolean().optional()
      })
    )
  })
)

/** Sleeping a server's workspace on the desktop, whose renderer runs the sleep. Fire and forget. */
export const relayHostWorktreeSleep = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'mobileRelay.host-sleep-worktree-or-skip',
    method: MOBILE_RELAY_HOST_SLEEP_WORKTREE_METHOD,
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('relay-host-worktree-slept', z.unknown())
  })
)

/**
 * Waking a server workspace's slept agents on the desktop that holds them. Read like
 * `worktree.activate`'s reply: only a headless verdict is looked at, by a total guard.
 */
export const relayHostSleepingAgentWake = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'mobileRelay.host-wake-sleeping-agents-or-skip',
    method: MOBILE_RELAY_HOST_WAKE_SLEEPING_AGENTS_METHOD,
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('relay-host-sleeping-agents-woken', z.unknown())
  })
)
