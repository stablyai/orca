import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const hybridSource = readFileSync(new URL('../app/hybrid.tsx', import.meta.url), 'utf8')
const hostCatalogSource = readFileSync(
  new URL('./mobile-web/use-mobile-web-host-catalog.ts', import.meta.url),
  'utf8'
)

describe('hybrid route host priming', () => {
  it('primes loaded host profiles before the selected host client opens', () => {
    expect(hostCatalogSource).toContain('const primeHosts = usePrimeHosts()')
    expect(hostCatalogSource).toContain('primeHosts(hosts)')
    expect(hybridSource.indexOf('useMobileWebHostCatalog()')).toBeLessThan(
      hybridSource.indexOf('useHostClient(selectedHostId)')
    )
  })

  it('delegates simulator-only host selection without changing screen presentation', () => {
    expect(hybridSource).toContain(
      'const e2eHostId = useMobileWebE2eHostSelection(hosts, selectedHostId, selectHost)'
    )
    expect(hybridSource).toContain('explicitHostId: params.hostId ?? e2eHostId')
  })
})
