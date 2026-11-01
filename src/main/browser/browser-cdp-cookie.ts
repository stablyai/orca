/** A cookie as CDP's Network domain reports it: unlike `cookies.get()`, with its partition key. */
export type CdpCookiePartitionKey = {
  topLevelSite?: string
  hasCrossSiteAncestor?: boolean
}

export type CdpCookie = {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  session?: boolean
  expires?: number
  sameSite?: string
  partitionKey?: CdpCookiePartitionKey | null
  partitionKeyOpaque?: boolean
}
