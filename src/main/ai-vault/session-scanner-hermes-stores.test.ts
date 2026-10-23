import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { hermesStoreHomes } from './session-scanner-hermes-stores'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

it('counts live identity-bearing profiles toward the store budget and reports truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-hermes-profile-budget-'))
  try {
    const profiles = join(root, 'profiles')
    await mkdir(join(profiles, 'ghost'), { recursive: true })
    await mkdir(join(profiles, 'live'), { recursive: true })
    await writeFile(join(profiles, 'live', 'config.yaml'), '')
    const options = { hermesSessionsDir: join(root, 'sessions') }
    const issues: AiVaultScanIssue[] = []
    expect(await hermesStoreHomes(options, [], issues)).toEqual([root, join(profiles, 'live')])
    await Promise.all(
      Array.from({ length: 257 }, async (_, index) => {
        const path = join(profiles, `profile-${index}`)
        await mkdir(path)
        await writeFile(join(path, 'state.db'), '')
      })
    )
    const homes = await hermesStoreHomes(options, [], issues)
    expect(homes).toHaveLength(257)
    expect(homes.slice(1, 4)).toEqual([
      join(profiles, 'live'),
      join(profiles, 'profile-0'),
      join(profiles, 'profile-1')
    ])
    expect(homes).not.toContain(join(profiles, 'ghost'))
    expect(issues).toEqual([
      expect.objectContaining({
        agent: 'hermes',
        kind: 'scope',
        path: profiles,
        message: 'Hermes profile discovery stopped at 256 profiles.'
      })
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('discovers directory links while preserving the profile source path and tombstones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-hermes-profile-link-'))
  try {
    const profiles = join(root, 'profiles')
    const target = join(root, 'profile-data')
    await mkdir(profiles)
    await mkdir(target)
    await writeFile(join(target, 'config.yaml'), '')
    await symlink(target, join(profiles, 'work'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(
      join(root, 'missing'),
      join(profiles, 'broken'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const options = { hermesSessionsDir: join(root, 'sessions') }
    const issues: AiVaultScanIssue[] = []
    expect(await hermesStoreHomes(options, [], issues)).toEqual([root, join(profiles, 'work')])
    await mkdir(join(profiles, '.deleted'))
    await writeFile(join(profiles, '.deleted', 'work'), '')
    expect(await hermesStoreHomes(options, [], issues)).toEqual([root])
    expect(issues).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
