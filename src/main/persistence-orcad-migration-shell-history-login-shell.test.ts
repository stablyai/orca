import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectHistoryEnv } from './terminal-history'
import { getHistoryRoot } from './terminal-history-paths'
import { DORMANT_WORKTREE_ID, manifest } from './persistence-orcad-migration-catalog-fixture'
import {
  BASH,
  ZSH,
  commitDurably,
  encodedHistories,
  hostHistory,
  hostHistoryDirectory,
  stage
} from './persistence-orcad-migration-shell-history-fixture'
import { createStore, testState } from './persistence-test-harness'

const { missingShells, presentShells } = vi.hoisted(() => ({
  missingShells: new Set<string>(),
  presentShells: new Set<string>()
}))

// Lets cases hide or provide shells for the real pane resolution; every other path is the real fs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      presentShells.has(String(path)) ||
      (!missingShells.has(String(path)) && actual.existsSync(path)),
    accessSync: (...args: Parameters<typeof actual.accessSync>) => {
      if (!presentShells.has(String(args[0]))) {
        actual.accessSync(...args)
      }
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

let desktopHistory: string

// The WSL bridge's lone `bash_history`, written by whatever the distro's login shell is.
async function moveLoneBridgeHistory(
  content: string,
  paneShellPath?: () => string,
  terminalDefaultShell?: string
): Promise<void> {
  const input = manifest()
  const store = createStore(paneShellPath ? { paneShellPath } : {})
  if (terminalDefaultShell) {
    store.updateSettings({ terminalDefaultShell })
  }
  stage(
    store,
    input,
    await encodedHistories(desktopHistory, [
      { worktreeId: DORMANT_WORKTREE_ID, file: 'bash_history', content }
    ])
  )
  expect(await commitDurably(store, input)).toBe('committed')
}

describe('moved WSL history lands under the shell a host pane runs', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-login-shell-'))
    desktopHistory = mkdtempSync(join(tmpdir(), 'orca-desktop-history-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
    rmSync(desktopHistory, { recursive: true, force: true })
    rmSync(getHistoryRoot(), { recursive: true, force: true })
    missingShells.clear()
    presentShells.clear()
    vi.unstubAllEnvs()
  })

  it('a zsh pane gets zsh_history, the HISTFILE a new zsh pane reads', async () => {
    await moveLoneBridgeHistory(ZSH, () => '/usr/bin/zsh')

    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(ZSH)
    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBeNull()
    const env: Record<string, string> = {}
    const injected = injectHistoryEnv(env, DORMANT_WORKTREE_ID, '/usr/bin/zsh', '/srv/x')
    expect(injected.histFile).toBe(join(hostHistoryDirectory(DORMANT_WORKTREE_ID), 'zsh_history'))
  })

  it('a bash pane keeps bash_history', async () => {
    await moveLoneBridgeHistory(BASH, () => '/bin/bash')

    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBe(BASH)
    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBeNull()
  })

  it.each(['/usr/bin/fish', '/usr/local/bin/nu', ''])(
    'any other pane shell (%j) keeps bash_history',
    async (shell) => {
      await moveLoneBridgeHistory(BASH, () => shell)

      expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBe(BASH)
      expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBeNull()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'a configured zsh that is not executable falls back as the spawn does, to bash',
    async () => {
      // Real pane resolution: SHELL names zsh, but no zsh exists, so the spawn falls back to bash.
      vi.stubEnv('SHELL', '/usr/bin/zsh')
      missingShells.add('/usr/bin/zsh')
      missingShells.add('/bin/zsh')
      await moveLoneBridgeHistory(BASH)

      expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBe(BASH)
      expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBeNull()
    }
  )

  it.skipIf(process.platform === 'win32')(
    "the host's default-shell setting wins over SHELL, as it does for a new pane",
    async () => {
      vi.stubEnv('SHELL', '/bin/bash')
      presentShells.add('/usr/bin/zsh')
      await moveLoneBridgeHistory(ZSH, undefined, '/usr/bin/zsh')

      expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(ZSH)
      expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBeNull()
    }
  )

  it('a worktree that sent both files keeps their own names', async () => {
    const input = manifest()
    const store = createStore({ paneShellPath: () => '/usr/bin/zsh' })
    stage(
      store,
      input,
      await encodedHistories(desktopHistory, [
        { worktreeId: DORMANT_WORKTREE_ID, file: 'zsh_history', content: ZSH },
        { worktreeId: DORMANT_WORKTREE_ID, file: 'bash_history', content: BASH }
      ])
    )
    expect(await commitDurably(store, input)).toBe('committed')

    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(ZSH)
    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBe(BASH)
  })
})
