import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  dropInheritedDevInstanceEnv,
  pickInstancePort,
  resolveDevProfile
} from './dev-instance-isolation.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function checkout(kind) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-dev-isolation-'))
  roots.push(root)
  if (kind === 'linked') {
    writeFileSync(path.join(root, '.git'), 'gitdir: /repo/.git/worktrees/feature\n')
  } else {
    mkdirSync(path.join(root, '.git'))
  }
  return root
}

const env = { HOME: '/home/dev', XDG_CONFIG_HOME: '/home/dev/.config' }

describe('resolveDevProfile', () => {
  it('isolates linked worktrees from each other and keeps orca-dev for the main checkout', () => {
    const first = resolveDevProfile({ repoRoot: checkout('linked'), env, platform: 'linux' })
    const second = resolveDevProfile({ repoRoot: checkout('linked'), env, platform: 'linux' })
    const main = resolveDevProfile({ repoRoot: checkout('main'), env, platform: 'linux' })

    expect(first.kind).toBe('worktree')
    expect(path.dirname(first.userDataPath)).toBe(path.join('/home/dev/.config', 'orca-dev-wt'))
    expect(first.userDataPath).not.toBe(second.userDataPath)
    expect(main).toEqual({
      kind: 'shared',
      userDataPath: path.join('/home/dev/.config', 'orca-dev')
    })
  })

  it('lets the flag, ORCA_DEV_PROFILE, and an explicit path override the default', () => {
    const repoRoot = checkout('linked')
    expect(resolveDevProfile({ repoRoot, mode: 'shared', env, platform: 'linux' }).kind).toBe(
      'shared'
    )
    expect(
      resolveDevProfile({
        repoRoot: checkout('main'),
        env: { ...env, ORCA_DEV_PROFILE: 'worktree' },
        platform: 'linux'
      }).kind
    ).toBe('worktree')
    expect(
      resolveDevProfile({
        repoRoot,
        mode: 'shared',
        env: { ...env, ORCA_DEV_USER_DATA_PATH: '/tmp/custom' },
        platform: 'linux'
      })
    ).toEqual({ kind: 'custom', userDataPath: path.resolve('/tmp/custom') })
    expect(() =>
      resolveDevProfile({ repoRoot, env: { ...env, ORCA_DEV_PROFILE: 'other' }, platform: 'linux' })
    ).toThrow('ORCA_DEV_PROFILE')
  })
})

describe('dropInheritedDevInstanceEnv', () => {
  it('drops a parent dev instance identity but keeps an explicit profile override', () => {
    const inherited = {
      ORCA_DEV_REPO_ROOT: '/worktrees/parent',
      ORCA_DEV_INSTANCE_KEY: '/worktrees/parent',
      ORCA_DEV_RENDERER_PORT: '15300',
      ORCA_USER_DATA_PATH: '/profiles/parent',
      ORCA_DEV_USER_DATA_PATH: '/profiles/parent'
    }
    dropInheritedDevInstanceEnv(inherited, '/worktrees/child')
    expect(inherited).toEqual({ ORCA_USER_DATA_PATH: '/profiles/parent' })

    const explicit = { ...inherited, ORCA_DEV_USER_DATA_PATH: '/profiles/mine' }
    dropInheritedDevInstanceEnv(explicit, '/worktrees/child')
    expect(explicit.ORCA_DEV_USER_DATA_PATH).toBe('/profiles/mine')

    const same = { ...inherited }
    dropInheritedDevInstanceEnv(same, '/worktrees/parent')
    expect(same).toEqual(inherited)
  })
})

describe('pickInstancePort', () => {
  it('is stable per key and sweeps forward past taken ports', async () => {
    const range = { base: 15200, spread: 200 }
    const first = await pickInstancePort('worktree-a', range, async () => true)
    expect(await pickInstancePort('worktree-a', range, async () => true)).toBe(first)
    expect(first).toBeGreaterThanOrEqual(15200)
    expect(first).toBeLessThan(15400)
    expect(await pickInstancePort('worktree-a', range, async (port) => port > first + 1)).toBe(
      first + 2
    )
    expect(await pickInstancePort('worktree-a', range, async () => false)).toBeNull()
  })
})
