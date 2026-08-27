import { getMainHttpClient } from '../network/http-client'

export async function firstPartyFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
): Promise<Response> {
  return getMainHttpClient().fetchWithSystemTrust(input, {
    ...init,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error'
  })
}
