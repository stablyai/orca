import type { AcpDialect } from './acp-dialect'

/** Gateway reasoning effort is session-wide, so one menu applies to every model. */
export const HERMES_ACP_DIALECT: AcpDialect = {
  clampsUnlistedEffort: true,
  // The ACP library turns a missing load (None) into {}. A real load always includes modes.
  loadedSessionMissing: (response) =>
    response.modes == null &&
    response.models == null &&
    response.configOptions == null &&
    response._meta == null
}
