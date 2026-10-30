import { z } from 'zod'
import type { ExecutionHostHealth } from '../../../src/shared/execution-host-health'
import { parseExecutionHostId } from '../../../src/shared/execution-host'
import {
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

// New desktop union arms must not discard the entire server entry.
const relayHostSchema = z.looseObject({
  hostId: runtimeHostIdSchema,
  label: z.string(),
  health: z.enum(HEALTH).catch('error'),
  relay: z.enum(RELAY).catch('unavailable'),
  stoppedOnDesktop: z.literal(true).optional().catch(undefined),
  unavailableOnDesktop: z.literal(true).optional().catch(undefined)
}) satisfies z.ZodType<MobileRelayHost>

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

// worktrees: null means the desktop has not fetched the server’s rows yet.
export const relayHostWorktreesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'mobileRelay.host-worktrees-or-skip',
    method: MOBILE_RELAY_HOST_WORKTREES_METHOD,
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'relay-host-worktrees',
      z.looseObject({ worktrees: z.array(z.unknown()).nullable() })
    )
  })
)
