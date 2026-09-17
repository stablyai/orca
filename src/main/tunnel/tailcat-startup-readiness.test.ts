import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('explicit Tailcat startup readiness', () => {
  it('awaits the desktop serve tunnel before publishing readiness', () => {
    const contents = source('src/main/startup/main-process-serve.ts')
    const tunnel = contents.indexOf('await attachTailcatTunnel')
    const readiness = contents.indexOf('await state.serveReadinessPublisher.publish')

    expect(tunnel).toBeGreaterThanOrEqual(0)
    expect(readiness).toBeGreaterThan(tunnel)
  })

  it('awaits the orcad tunnel before publishing readiness', () => {
    const contents = source('src/main/orcad/orcad-entry.ts')
    const tunnel = contents.indexOf('await attachTailcatTunnel')
    const readiness = contents.indexOf('await new ServeReadinessPublisher().publish')

    expect(tunnel).toBeGreaterThanOrEqual(0)
    expect(readiness).toBeGreaterThan(tunnel)
  })
})
