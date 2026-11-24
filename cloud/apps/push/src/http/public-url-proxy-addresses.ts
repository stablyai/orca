import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'

const DNS_TIMEOUT_MS = 2_000

type AddressResolver = {
  resolve4(host: string): Promise<string[]>
  resolve6(host: string): Promise<string[]>
}

// Behind Google's load balancer the last x-forwarded-for hop is the balancer's own
// address, which is what the public host name resolves to; no client sends from it.
export async function resolvePublicUrlProxyAddresses(
  publicUrl: string,
  resolver: AddressResolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 })
): Promise<string[]> {
  const host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0) return [host.toLowerCase()]
  const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
  return answers.flatMap((answer) =>
    answer.status === 'fulfilled' ? answer.value.map((address) => address.toLowerCase()) : []
  )
}
