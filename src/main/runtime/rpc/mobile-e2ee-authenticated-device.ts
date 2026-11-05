import type { DevicePrincipal } from '../device-principal'

export type E2EEAuthenticatedDevice = DevicePrincipal & {
  // Absent for a keyed row, which never presented a bearer.
  deviceToken?: string
}
