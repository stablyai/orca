import type { CdpUserAgentMetadata } from '../../../identity/browser-tab-identity'

/** An empty userAgent clears the CDP override. */
export type CdpUserAgentOverride = {
  userAgent: string
  userAgentMetadata?: CdpUserAgentMetadata
}

export type CdpUserAgentOverrideOperation = {
  sequence: number
  override: CdpUserAgentOverride
}

export type CdpUserAgentOverrideState = {
  confirmed: CdpUserAgentOverrideOperation | null
  nextSequence: number
  pending: CdpUserAgentOverrideOperation[]
}
