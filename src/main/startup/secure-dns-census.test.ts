import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'

const REPO_ROOT = join(import.meta.dirname, '../../..')
const CENSUS_FILE = 'src/main/startup/secure-dns-census.test.ts'

// Why: app.configureHostResolver is process-wide, so any non-'off' secureDnsMode sends DoH queries from the desktop
// network stack — outside every route partition's SOCKS tunnel — no matter which partition triggered the lookup.
describe('secure DNS census', () => {
  it('never configures a host resolver with a DoH mode', async () => {
    const files = await glob(['src/**/*.ts', 'src/**/*.tsx'], {
      cwd: REPO_ROOT,
      ignore: ['**/node_modules/**', CENSUS_FILE]
    })

    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      if (!source.includes('configureHostResolver')) {
        continue
      }
      for (const mode of source.matchAll(/secureDnsMode\s*:\s*'([^']*)'/g)) {
        if (mode[1] !== 'off') {
          offenders.push(`${file}: secureDnsMode: '${mode[1]}'`)
        }
      }
      if (!/secureDnsMode\s*:/.test(source)) {
        offenders.push(`${file}: configureHostResolver without an explicit secureDnsMode`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('detects a DoH mode when one is present', () => {
    // Why: the census reads real sources, so it passes vacuously today; prove the matcher on a known offender.
    const offending = "app.configureHostResolver({ secureDnsMode: 'automatic' })"
    const modes = [...offending.matchAll(/secureDnsMode\s*:\s*'([^']*)'/g)].map((match) => match[1])

    expect(offending.includes('configureHostResolver')).toBe(true)
    expect(modes).toEqual(['automatic'])
    expect(modes.every((mode) => mode === 'off')).toBe(false)
  })
})
