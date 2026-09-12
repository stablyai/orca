import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  browserHostClientIdentityPath,
  readOrCreateBrowserHostClientId
} from './browser-host-client-identity'

function profileDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'orca-host-identity-'))
}

describe('browser host client identity', () => {
  it('keeps one hosting identity across relaunches of the same profile', () => {
    const directory = profileDirectory()

    const first = readOrCreateBrowserHostClientId(directory)
    const second = readOrCreateBrowserHostClientId(directory)

    // Why: a fresh id per launch is what made the server fence the lease and drop the tabs.
    expect(second).toBe(first)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('gives each Orca profile its own hosting identity', () => {
    expect(readOrCreateBrowserHostClientId(profileDirectory())).not.toBe(
      readOrCreateBrowserHostClientId(profileDirectory())
    )
  })

  it('persists the identity where the next launch reads it', () => {
    const directory = profileDirectory()

    const identity = readOrCreateBrowserHostClientId(directory)

    expect(JSON.parse(readFileSync(browserHostClientIdentityPath(directory), 'utf-8'))).toEqual({
      version: 1,
      browserHostClientId: identity
    })
  })

  it.each([
    ['unparseable content', 'not json at all'],
    ['a future store version', JSON.stringify({ version: 2, browserHostClientId: 'kept' })],
    ['a missing identity', JSON.stringify({ version: 1 })],
    ['a non-string identity', JSON.stringify({ version: 1, browserHostClientId: 7 })],
    ['an empty identity', JSON.stringify({ version: 1, browserHostClientId: '' })],
    [
      'an identity past the wire limit',
      JSON.stringify({ version: 1, browserHostClientId: 'x'.repeat(257) })
    ]
  ])('mints a fresh identity rather than trusting %s', (_label, contents) => {
    const directory = profileDirectory()
    writeFileSync(browserHostClientIdentityPath(directory), contents)

    const identity = readOrCreateBrowserHostClientId(directory)

    expect(identity).toMatch(/^[0-9a-f-]{36}$/)
    expect(readOrCreateBrowserHostClientId(directory)).toBe(identity)
  })

  it('still names the host when the profile cannot be written', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A path whose parent is a file, so the directory can never be created.
    const file = join(profileDirectory(), 'occupied')
    writeFileSync(file, 'not a directory')

    expect(readOrCreateBrowserHostClientId(join(file, 'nested'))).toMatch(/^[0-9a-f-]{36}$/)
    expect(warn).toHaveBeenCalled()
  })
})
