import { describe, expect, it, vi } from 'vitest'
import { join, dirname } from 'node:path'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import {
  createManagedHome,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => testState.fakeHomeDir
}))

describe('managed Codex home cleanup recovery', () => {
  registerCodexAccountsTestHomes()

  async function lifecycle() {
    const { CodexManagedHomePath } = await import('./codex-managed-home-path')
    const { CodexManagedHomeLifecycle } = await import('./codex-managed-home-lifecycle')
    return new CodexManagedHomeLifecycle(new CodexManagedHomePath(() => ''))
  }

  it('preserves ownership across a partial deletion so a locked credential can be retried', async () => {
    const fs = await vi.importActual<typeof NodeFs>('node:fs')
    const home = fs.realpathSync(
      createManagedHome(testState.userDataDir, 'account-1', '', 'secret')
    )
    const marker = join(home, '.orca-managed-home')
    const auth = join(home, 'auth.json')
    let locked = true
    vi.doMock('node:fs', () => ({
      ...fs,
      rmSync: (
        target: Parameters<typeof fs.rmSync>[0],
        options: Parameters<typeof fs.rmSync>[1]
      ) => {
        if (locked && (target === home || target === auth)) {
          // Model rm's partial traversal: the marker sorts before the held auth file.
          if (target === home) {
            fs.rmSync(marker, { force: true })
          }
          throw Object.assign(new Error('credential locked'), { code: 'EBUSY' })
        }
        fs.rmSync(target, options)
      }
    }))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const homes = await lifecycle()
      expect(homes.safeRemove(home, 'account-1')).toBe(false)
      expect(fs.readFileSync(marker, 'utf8')).toBe('account-1\n')
      expect(fs.readFileSync(auth, 'utf8')).toBe('secret')
      locked = false
      expect(homes.safeRemove(home, 'account-1')).toBe(true)
      expect(fs.existsSync(home)).toBe(false)
    } finally {
      warning.mockRestore()
      vi.doUnmock('node:fs')
    }
  })

  it('finishes an empty home left by an interruption after marker deletion', async () => {
    const fs = await vi.importActual<typeof NodeFs>('node:fs')
    const home = createManagedHome(testState.userDataDir, 'account-1')
    fs.rmSync(join(home, '.orca-managed-home'))
    const homes = await lifecycle()
    expect(homes.safeRemove(home, 'account-1')).toBe(true)
    expect(fs.existsSync(home)).toBe(false)
  })

  it('leaves new files intact if a previously empty unmarked home changes during cleanup', async () => {
    const fs = await vi.importActual<typeof NodeFs>('node:fs')
    const home = fs.realpathSync(createManagedHome(testState.userDataDir, 'account-1'))
    fs.rmSync(join(home, '.orca-managed-home'))
    vi.doMock('node:fs', () => ({
      ...fs,
      rmdirSync: (target: Parameters<typeof fs.rmdirSync>[0]) => {
        fs.writeFileSync(join(home, 'auth.json'), 'new credentials')
        fs.rmdirSync(target)
      }
    }))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const homes = await lifecycle()
      expect(homes.safeRemove(home, 'account-1')).toBe(false)
      expect(fs.readFileSync(join(home, 'auth.json'), 'utf8')).toBe('new credentials')
    } finally {
      warning.mockRestore()
      vi.doUnmock('node:fs')
    }
  })

  it('refuses an unmarked nonempty home or an empty directory outside account storage', async () => {
    const fs = await vi.importActual<typeof NodeFs>('node:fs')
    const home = createManagedHome(testState.userDataDir, 'account-1', '', 'secret')
    fs.rmSync(join(home, '.orca-managed-home'))
    const outside = join(testState.fakeHomeDir, 'empty')
    fs.mkdirSync(outside)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const homes = await lifecycle()
      expect(homes.safeRemove(home, 'account-1')).toBe(false)
      expect(homes.safeRemove(outside, 'account-1')).toBe(false)
      expect(fs.readFileSync(join(home, 'auth.json'), 'utf8')).toBe('secret')
      expect(fs.existsSync(outside)).toBe(true)
    } finally {
      warning.mockRestore()
    }
  })

  it('confirms an already deleted WSL home through its readable parent', async () => {
    const fs = await vi.importActual<typeof NodeFs>('node:fs')
    const home = createManagedHome(testState.userDataDir, 'account-1')
    fs.rmSync(home, { recursive: true })
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (candidate: string) =>
        candidate === home
          ? {
              distro: 'Ubuntu',
              linuxPath: '/home/alice/.local/share/orca/codex-accounts/account-1/home'
            }
          : null
    }))
    try {
      const homes = await lifecycle()
      expect(homes.safeRemove(home, 'account-1')).toBe(true)
      fs.rmSync(dirname(home), { recursive: true })
      expect(homes.safeRemove(home, 'account-1')).toBe(true)
    } finally {
      vi.doUnmock('../../shared/wsl-paths')
    }
  })

  it('keeps WSL cleanup pending when its parent cannot be observed', async () => {
    const fs = await vi.importActual<typeof NodeFs>('node:fs')
    const home = createManagedHome(testState.userDataDir, 'account-1')
    fs.rmSync(home, { recursive: true })
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (candidate: string) =>
        candidate === home
          ? {
              distro: 'Ubuntu',
              linuxPath: '/home/alice/.local/share/orca/codex-accounts/account-1/home'
            }
          : null
    }))
    vi.doMock('node:fs', () => ({
      ...fs,
      readdirSync: () => {
        throw Object.assign(new Error('share unavailable'), { code: 'EIO' })
      }
    }))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const homes = await lifecycle()
      expect(homes.safeRemove(home, 'account-1')).toBe(false)
    } finally {
      warning.mockRestore()
      vi.doUnmock('node:fs')
      vi.doUnmock('../../shared/wsl-paths')
    }
  })
})
