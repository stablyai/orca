import type {
  MCodeCloudCapabilities,
  MCodeCloudOrgSummary,
  MCodeProfileCloudSummary
} from '../../shared/mcode-profiles'

export type MCodeCloudSessionExchangeResponse = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  cloud: MCodeProfileCloudSummary
  organizations?: MCodeCloudOrgSummary[]
  capabilities: MCodeCloudCapabilities
}
