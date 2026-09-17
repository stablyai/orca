import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

/**
 * The status the transport's own `status.get` reads.
 *
 * Checked against src/main/runtime/rpc/methods/status.ts, which spreads `runtime.getStatus()` and
 * adds `appVersion` and `remoteUpdateSupport`. Every member is optional, because this reply has to
 * decode from every host version the protocol gate admits and each of the four fields arrived in a
 * different release: an older host that answers none of them must still read, or the gate would
 * refuse the build it exists to evaluate.
 *
 * `capabilities` is an array of strings and salvages whole rather than per element, because that
 * was main's own rule: the probe read the member off the raw reply and took the list only when
 * `Array.isArray(raw) && raw.every((value) => typeof value === 'string')`, so one bad entry cost
 * the whole list. No line is cited for it because this change is what deleted that code from
 * runtime-capability-probe.ts; the behaviour it describes lives in the reply-salvage drop below.
 * Dropping just the bad entry would publish a capability set main never published, which the
 * `transport-capability-probe-non-string-capabilities-drop` golden records as `published: [[]]`.
 *
 * The object itself is required, and the three callers each keep the guard that decides what an
 * unreadable status means to them: see `hostStatusGatesRead`, `readProbedHostCapabilities` and
 * `hostAnsweredStatusProbe` in host-status-probe-operations.ts.
 */
export const hostStatusSchema = z.looseObject({
  protocolVersion: salvagedOptional('protocolVersion', z.number()),
  minCompatibleMobileVersion: salvagedOptional('minCompatibleMobileVersion', z.number()),
  appVersion: salvagedOptional('appVersion', z.string()),
  floatingWorkspaceEnabled: salvagedOptional('floatingWorkspaceEnabled', z.boolean()),
  capabilities: salvagedOptional('capabilities', z.array(z.string()))
})

export type HostStatusReply = z.output<typeof hostStatusSchema>
