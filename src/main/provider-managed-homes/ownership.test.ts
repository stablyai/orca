import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertOwnedManagedProviderHome, MANAGED_PROVIDER_HOME_MARKER } from './ownership'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function createManagedHome(provider: 'grok' | 'gemini') {
  const systemHome = mkdtempSync(join(tmpdir(), `orca-${provider}-system-`))
  roots.push(systemHome)
  const managedAccountsRoot = join(systemHome, 'orca-data', `${provider}-accounts`)
  const accountId = 'account-a'
  const candidatePath = join(managedAccountsRoot, accountId, 'home')
  mkdirSync(candidatePath, { recursive: true })
  writeFileSync(join(candidatePath, MANAGED_PROVIDER_HOME_MARKER), `${provider}:${accountId}\n`)
  return {
    provider,
    systemHomePath: systemHome,
    managedAccountsRoot,
    accountId,
    candidatePath
  } as const
}

describe('assertOwnedManagedProviderHome', () => {
  it('allows a Gemini managed root below the user home without allowing the user home itself', () => {
    const args = createManagedHome('gemini')
    expect(assertOwnedManagedProviderHome(args)).toBe(realpathSync(args.candidatePath))
    expect(() =>
      assertOwnedManagedProviderHome({ ...args, candidatePath: args.systemHomePath })
    ).toThrow(/persisted account ID|system home/i)
  })

  it('rejects a Grok managed path below the active GROK_HOME boundary', () => {
    const args = createManagedHome('grok')
    expect(() => assertOwnedManagedProviderHome(args)).toThrow(/system home/i)
  })
})
