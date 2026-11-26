import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaProfileCloudSummary
} from '../../../shared/orca-profiles/orca-profiles'

export type OrcaCloudSessionExchangeResponse = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  cloud: OrcaProfileCloudSummary
  organizations?: OrcaCloudOrgSummary[]
  capabilities: OrcaCloudCapabilities
  /** From a refresh that sent this install's machine id, on an auth service that issues it. */
  wakeToken?: OrcaCloudWakeToken
}

/** Opens the invite wake socket only; refused as any other token. */
export type OrcaCloudWakeToken = { token: string; expiresAt: number }
