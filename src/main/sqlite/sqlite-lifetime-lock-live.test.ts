import { symlinkSync, renameSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { installLifetimeLockProcessFixture } from './lifetime-lock-process-fixture'

const bun = process.env.ORCA_TEST_BUN_RUNTIME
const fixture = installLifetimeLockProcessFixture(
  'src/main/sqlite/sqlite-lifetime-lock-probe-fixture.ts'
)
const { probe, hold } = fixture
const databasePath = () => join(fixture.createProfile(), 'lifetime.sqlite')

const pairs = [
  { owner: process.execPath, contender: process.execPath, label: 'Node/Node' },
  ...(bun
    ? [
        { owner: bun, contender: bun, label: 'Bun/Bun' },
        { owner: process.execPath, contender: bun, label: 'Node/Bun' },
        { owner: bun, contender: process.execPath, label: 'Bun/Node' }
      ]
    : [])
]

it.each(pairs)('retains exclusion until graceful release: $label', async ({ owner, contender }) => {
  const path = databasePath()
  const { child } = await hold(owner, path)
  expect(await probe(contender, path)).toEqual({ state: 'busy' })
  expect(await probe(contender, databasePath())).toMatchObject({ state: 'acquired' })
  child.stdin?.write('release\n')
  await vi.waitFor(() => expect(child.exitCode).toBe(0))
  expect(await probe(contender, path)).toMatchObject({ state: 'acquired' })
})

it.skipIf(process.platform === 'win32').each(pairs)(
  'suspended owner retains exclusion; only abrupt exit releases it: $label',
  async ({ owner, contender }) => {
    const path = databasePath()
    const { child } = await hold(owner, path)
    child.kill('SIGSTOP')
    expect(await probe(contender, path)).toEqual({ state: 'busy' })
    child.kill('SIGKILL')
    await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'))
    expect(await probe(contender, path)).toMatchObject({ state: 'acquired' })
  }
)

it.each(pairs)(
  'aliases contend on the physical lock file: $label',
  async ({ owner, contender }) => {
    const profile = fixture.createProfile()
    const alias = `${profile}-alias`
    symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await hold(owner, join(profile, 'lifetime.sqlite'))
    expect(await probe(contender, join(alias, 'lifetime.sqlite'))).toEqual({ state: 'busy' })
  }
)

it.each(pairs)(
  'an isolated keeper survives descriptor closes in its client: $label',
  async ({ owner, contender }) => {
    const path = databasePath()
    await hold(owner, path)
    closeSync(openSync(path, 'r'))
    expect(await probe(contender, path)).toEqual({ state: 'busy' })
  }
)

it
  .skipIf(process.platform === 'win32')
  .each(pairs.filter(({ owner }) => owner === process.execPath))(
  'exposes Node owner descriptor-close loss despite active transaction: $label',
  async ({ owner, contender }) => {
    const path = databasePath()
    const { child, waitFor } = await hold(owner, path)
    expect(await probe(contender, path)).toEqual({ state: 'busy' })
    child.stdin?.write('external-read\n')
    expect(await waitFor('external-read')).toMatchObject({ transaction: true })
    expect(await probe(contender, path)).toMatchObject({ state: 'acquired' })
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
  }
)

it.skipIf(process.platform === 'win32').each(pairs)(
  'exposes pathname replacement splitting two live owners: $label',
  async ({ owner, contender }) => {
    const path = databasePath()
    const { child } = await hold(owner, path)
    renameSync(path, `${path}.retained`)
    expect(await probe(contender, path)).toMatchObject({ state: 'acquired' })
    expect(await probe(contender, `${path}.retained`)).toEqual({ state: 'busy' })
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
  }
)
