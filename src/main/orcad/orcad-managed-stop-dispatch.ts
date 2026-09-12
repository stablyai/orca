import {
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopRequest
} from '../../shared/orcad-managed-stop-request'

// Retain uncertainty across adapter reconfiguration for the lifetime of this process.
const dispatched = new Set<string>()

export function recordOrcadManagedStopDispatch(
  version: string,
  authority: OrcadManagedStopRequest['authority'],
  instance: OrcadManagedStopRequest['instance']
): void {
  const request = { schemaVersion: 1, version, authority, instance }
  dispatched.add(JSON.stringify(OrcadManagedStopRequestSchema.parse(request)))
}

export function wasOrcadManagedStopDispatched(request: OrcadManagedStopRequest): boolean {
  return dispatched.has(JSON.stringify(OrcadManagedStopRequestSchema.parse(request)))
}
