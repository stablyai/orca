import { ConnectorWakeHostIdSchema } from '../../../packages/connector-contract/src/wake-messages'

export function isHostId(value: string): boolean {
  return ConnectorWakeHostIdSchema.safeParse(value).success
}

// One object per host. The canary uses the same prefix but can never pass ConnectorWakeHostIdSchema.
export function hostObjectName(hostId: string): string {
  return `host:${hostId}`
}
