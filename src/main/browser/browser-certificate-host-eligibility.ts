import { lookup } from 'node:dns/promises'

import { isEligibleLocalCertificateHost } from '../../shared/browser-url'

type LookupAddresses = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<readonly { address: string }[]>

export async function isEligibleResolvedLocalCertificateHost(
  hostname: string,
  url: string,
  resolveProxy: (url: string) => Promise<string>,
  lookupAddresses: LookupAddresses = lookup
): Promise<boolean> {
  if (isEligibleLocalCertificateHost(hostname)) {
    return true
  }
  try {
    // Why: local DNS must not authorize a certificate for a request Chromium sends through a proxy.
    if ((await resolveProxy(url)).trim().toUpperCase() !== 'DIRECT') {
      return false
    }
    const addresses = await lookupAddresses(hostname, { all: true, verbatim: true })
    return (
      addresses.length > 0 &&
      addresses.every(({ address }) => isEligibleLocalCertificateHost(address))
    )
  } catch {
    return false
  }
}
