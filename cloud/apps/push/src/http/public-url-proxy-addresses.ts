import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

const DNS_TIMEOUT_MS = 2_000
const DNS_ATTEMPTS = 3
const DNS_RETRY_DELAY_MS = 1_000

type AddressResolver = {
  resolve4(host: string): Promise<string[]>
  resolve6(host: string): Promise<string[]>
}

export type PublicUrlProxyAddressOptions = {
  resolver?: AddressResolver
  /** Without discovered addresses every client behind the balancer shares its bucket, so startup fails instead. */
  required: boolean
  attempts?: number
  retryDelayMs?: number
}

// Behind Google's load balancer the last x-forwarded-for hop is the balancer's own
// address, which is what the public host name resolves to; no client sends from it.
export async function resolvePublicUrlProxyAddresses(
  publicUrl: string,
  options: PublicUrlProxyAddressOptions
): Promise<string[]> {
  const host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0) return [host.toLowerCase()]
  // Nothing sits in front of a local server, and DNS servers do not answer for localhost.
  if (host === 'localhost' || host.endsWith('.localhost')) return []
  const resolver = options.resolver ?? new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 })
  const attempts = options.attempts ?? DNS_ATTEMPTS
  for (let attempt = 1; ; attempt++) {
    const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
    // One family answering is enough; the balancer may have no IPv6 address.
    if (answers.some((answer) => answer.status === 'fulfilled')) {
      return answers.flatMap((answer) =>
        answer.status === 'fulfilled' ? answer.value.map((address) => address.toLowerCase()) : []
      )
    }
    if (attempt >= attempts) break
    await sleep(options.retryDelayMs ?? DNS_RETRY_DELAY_MS)
  }
  if (options.required) {
    throw new Error(
      `Could not resolve ${host} to find the load balancer's address; set ORCA_PUSH_TRUSTED_PROXY_ADDRESSES to skip discovery.`
    )
  }
  console.warn(JSON.stringify({ event: 'orca_push_proxy_discovery_failed', host }))
  return []
}
