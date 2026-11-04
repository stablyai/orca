import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, readFileSync, readdirSync, statSync } from 'node:fs'
import './config-toml-trust'
import {
  createTrustConfigFixture,
  removeTrustConfigFixture
} from './config-toml-trust-test-fixtures'
import { upsertProjectTrustContent } from './config-toml-project-trust'
import { writeTomlConfigAtomically } from '../../configuration/toml/config-toml-atomic-write'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    removeTrustConfigFixture(fixture)
  }
})

describe('config.toml partial and stale writes', () => {
  it('preserves a truncated malformed prefix while appending trust', () => {
    const partial = ['model = "gpt-5"', '[mcp_servers.partial', 'command = "still-user-data'].join(
      '\n'
    )
    const updated = upsertProjectTrustContent(partial, 'C:/Remote/Repo', 'trusted', {
      alreadyCanonical: true
    })

    expect(updated.startsWith(partial)).toBe(true)
    expect(updated).toContain('[projects."C:/Remote/Repo"]')
  })

  it('pins the no-lock stale-writer policy to one complete last snapshot', () => {
    const fixture = createTrustConfigFixture()
    fixtures.push(fixture.tmpDir)
    const original = 'model = "gpt-5"\n'
    const first = upsertProjectTrustContent(original, '/remote/first', 'trusted', {
      alreadyCanonical: true
    })
    const second = upsertProjectTrustContent(original, '/remote/second', 'trusted', {
      alreadyCanonical: true
    })

    writeTomlConfigAtomically(fixture.configPath, first)
    writeTomlConfigAtomically(fixture.configPath, second)

    expect(readFileSync(fixture.configPath, 'utf-8')).toBe(second)
    expect(readFileSync(fixture.configPath, 'utf-8')).not.toContain('/remote/first')
    expect(readdirSync(fixture.tmpDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'preserves permissions across stale atomic writers',
    () => {
      const fixture = createTrustConfigFixture()
      fixtures.push(fixture.tmpDir)
      writeTomlConfigAtomically(fixture.configPath, 'model = "first"\n')
      chmodSync(fixture.configPath, 0o600)

      writeTomlConfigAtomically(fixture.configPath, 'model = "second"\n')

      expect(statSync(fixture.configPath).mode & 0o777).toBe(0o600)
    }
  )
})
