import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'
import { NODE_PLATFORM_NAMES } from './mobile-runtime-host-platform'

// Keep fields optional across host versions; older admitted hosts may report none.
// Salvage capabilities as a whole: dropping only bad entries would publish a set the legacy probe rejected.
// Require an object; each transport reader decides what unreadable status means to its own fallback policy.
export const hostStatusSchema = z.looseObject({
  protocolVersion: salvagedOptional('protocolVersion', z.number()),
  minCompatibleMobileVersion: salvagedOptional('minCompatibleMobileVersion', z.number()),
  appVersion: salvagedOptional('appVersion', z.string()),
  floatingWorkspaceEnabled: salvagedOptional('floatingWorkspaceEnabled', z.boolean()),
  capabilities: salvagedOptional('capabilities', z.array(z.string())),
  hostPlatform: salvagedOptional('hostPlatform', z.enum(NODE_PLATFORM_NAMES)),
  machineName: salvagedOptional('machineName', z.string())
})

export type HostStatusReply = z.output<typeof hostStatusSchema>
