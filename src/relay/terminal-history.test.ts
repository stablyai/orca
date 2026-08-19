import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashWorktreeId } from '../main/terminal-history-id'
import { fishHistorySessionName, relayFishHistorySessionName } from '../main/fish-history-session'
import {
  deleteRelayHistory,
  injectRelayFishHistoryEnv,
  injectRelayHistoryEnv
} from './terminal-history'

const worktreeId = 'relay-test::/remote/worktree'
const historyDir = join(homedir(), '.orca-remote', 'terminal-history')
const historyPrefix = hashWorktreeId(worktreeId)

afterEach(() => {
  for (const filename of ['bash_history', 'zsh_history']) {
    rmSync(join(historyDir, `${historyPrefix}-${filename}`), { force: true })
  }
})

describe('relay shell history', () => {
  it.each(['/bin/bash', '/usr/bin/zsh'])('scopes %s without replacing caller HISTFILE', (shell) => {
    const env: Record<string, string> = {}
    const dir = injectRelayHistoryEnv(env, worktreeId, shell)
    expect(dir).toBe(historyDir)
    expect(env.HISTFILE).toBe(
      join(
        historyDir,
        `${historyPrefix}-${shell.endsWith('bash') ? 'bash_history' : 'zsh_history'}`
      )
    )

    const custom = { HISTFILE: '/custom/history' }
    expect(injectRelayHistoryEnv(custom, worktreeId, shell)).toBeNull()
    expect(custom.HISTFILE).toBe('/custom/history')
  })

  it.each([
    ['relay', join(historyDir, `${hashWorktreeId('relay-test::/remote/other')}-zsh_history`)],
    [
      'desktop',
      join(
        '/fake/userData/terminal-history',
        hashWorktreeId('relay-test::/remote/other'),
        'zsh_history'
      )
    ]
  ])('replaces a %s HISTFILE inherited from a parent Orca', (_kind, inherited) => {
    // HISTFILE is exported, so a relay (or the client that spawned it) started
    // from an Orca pane would otherwise scope every remote pane to that one
    // worktree's history file.
    const env: Record<string, string> = { HISTFILE: inherited }

    expect(injectRelayHistoryEnv(env, worktreeId, '/usr/bin/zsh')).toBe(historyDir)
    expect(env.HISTFILE).toBe(join(historyDir, `${historyPrefix}-zsh_history`))
  })

  it('does not scope unsupported shells and cleans up idempotently', () => {
    const env: Record<string, string> = {}
    expect(injectRelayHistoryEnv(env, worktreeId, '/bin/fish')).toBeNull()
    deleteRelayHistory(worktreeId)
    deleteRelayHistory(worktreeId)
    expect(existsSync(join(historyDir, `${historyPrefix}-bash_history`))).toBe(false)
  })

  it.each([
    ['relay', relayFishHistorySessionName(hashWorktreeId('relay-test::/remote/other'))],
    ['desktop', fishHistorySessionName(hashWorktreeId('relay-test::/remote/other'))]
  ])('replaces an inherited %s fish_history', (_kind, inherited) => {
    // fish EXPORTS fish_history, so a relay started from a fish pane would give
    // every remote pane the launching worktree's session file.
    const env: Record<string, string> = { fish_history: inherited }

    injectRelayFishHistoryEnv(env, worktreeId)

    expect(env.fish_history).toBe(relayFishHistorySessionName(historyPrefix))
  })

  it('preserves a caller-supplied fish_history', () => {
    const env: Record<string, string> = { fish_history: 'mine' }

    injectRelayFishHistoryEnv(env, worktreeId)

    expect(env.fish_history).toBe('mine')
  })

  it.skipIf(process.platform === 'win32')('refuses a pre-existing final symlink', () => {
    mkdirSync(historyDir, { recursive: true })
    const target = join(historyDir, 'relay-unrelated-history')
    const path = join(historyDir, `${historyPrefix}-bash_history`)
    writeFileSync(target, 'unrelated')
    symlinkSync(target, path)

    expect(injectRelayHistoryEnv({}, worktreeId, '/bin/bash')).toBeNull()
    expect(readFileSync(target, 'utf8')).toBe('unrelated')
    rmSync(path)
    rmSync(target)
  })
})
