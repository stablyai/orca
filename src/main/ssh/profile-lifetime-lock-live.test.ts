import { createRequire } from 'node:module'
import { join } from 'node:path'
import { renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { installLifetimeLockProcessFixture } from '../sqlite/lifetime-lock-process-fixture'
import type { ProfileLifetimeLockBinding } from './profile-lifetime-lock'

const addon = process.env.ORCA_TEST_PROFILE_LOCK_ADDON
const bun = process.env.ORCA_TEST_BUN_RUNTIME

describe.skipIf(!addon)('native profile lifetime exclusion', () => {
  const fixture = installLifetimeLockProcessFixture(
    'src/main/ssh/profile-lifetime-lock-probe-fixture.ts',
    [addon!],
    { state: 'acquired' }
  )
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

  it.each(pairs)(
    'survives unrelated fd close until explicit release: $label',
    async ({ owner, contender }) => {
      const profile = fixture.createProfile()
      const { child, waitFor } = await fixture.hold(owner, profile)
      expect(await fixture.probe(contender, profile)).toEqual({ state: 'busy' })
      child.stdin?.write('external-read\n')
      await waitFor('external-read')
      expect(await fixture.probe(contender, profile)).toEqual({ state: 'busy' })
      expect(await fixture.probe(contender, fixture.createProfile())).toEqual({ state: 'acquired' })
      child.stdin?.write('release\n')
      await vi.waitFor(() => expect(child.exitCode).toBe(0))
      expect(await fixture.probe(contender, profile)).toEqual({ state: 'acquired' })
    }
  )

  it.skipIf(process.platform === 'win32').each(pairs)(
    'paused owner remains exclusive; abrupt exit releases: $label',
    async ({ owner, contender }) => {
      const profile = fixture.createProfile()
      const { child } = await fixture.hold(owner, profile)
      child.kill('SIGSTOP')
      expect(await fixture.probe(contender, profile)).toEqual({ state: 'busy' })
      child.kill('SIGKILL')
      await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'))
      expect(await fixture.probe(contender, profile)).toEqual({ state: 'acquired' })
    }
  )

  it.each(pairs)('canonical and aliased profiles contend: $label', async ({ owner, contender }) => {
    const profile = fixture.createProfile()
    const alias = `${profile}-alias`
    symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await fixture.hold(owner, profile)
    expect(await fixture.probe(contender, alias)).toEqual({ state: 'busy' })
  })

  it.skipIf(process.platform === 'win32').each(pairs)(
    'invalidates held authority when its lock pathname is replaced: $label',
    async ({ owner }) => {
      const profile = fixture.createProfile()
      const { child, waitFor } = await fixture.hold(owner, profile)
      const path = join(profile, 'profile-lifetime.lock')
      renameSync(path, `${path}.retained`)
      writeFileSync(path, '')
      child.stdin?.write('assert\n')
      await waitFor('invalid')
      expect(child.exitCode).toBeNull()
    }
  )

  it('refuses foreign tokens and contending handles within one process', () => {
    const binding: ProfileLifetimeLockBinding = createRequire(import.meta.url)(addon!)
    for (const token of [{}, Object.create(null), []]) {
      expect(() => binding.release(token)).toThrow()
      expect(() => binding.assertCurrent(token)).toThrow()
    }
    const path = join(fixture.createProfile(), 'profile-lifetime.lock')
    const token = binding.acquire(path)
    try {
      expect(() => binding.acquire(path)).toThrow()
      binding.assertCurrent(token)
    } finally {
      binding.release(token)
    }
    binding.release(token)
    expect(() => binding.assertCurrent(token)).toThrow()
  })
})
