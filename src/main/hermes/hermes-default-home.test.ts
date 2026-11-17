import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveHermesActiveProfileHome } from './hermes-default-home'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('pins the profile `hermes profile use` selected, and the root otherwise', async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-hermes-profile-'))
  mkdirSync(join(root, 'profiles', 'work'), { recursive: true })
  expect(await resolveHermesActiveProfileHome(root)).toBe(root)
  writeFileSync(join(root, 'active_profile'), 'work\n')
  expect(await resolveHermesActiveProfileHome(root)).toBe(join(root, 'profiles', 'work'))
  // A home that already names a profile is the one Hermes runs.
  const other = join(root, 'profiles', 'other')
  expect(await resolveHermesActiveProfileHome(other)).toBe(other)
  writeFileSync(join(root, 'active_profile'), 'missing\n')
  expect(await resolveHermesActiveProfileHome(root)).toBe(root)
})
