import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-router'
import { installClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import { makeRuntimePtySpawnTestDeps } from './spawn-preflight-test-deps-fixture'

vi.mock('../../../codex/history/index/codex-state-db-backfill-recovery', () => ({
  ensureCodexStateDbBackfillRecoveryStarted: async () => {}
}))

const hostClaudeRoute: Pick<ClaudeProfileRouter, 'terminalEnv'> = {
  terminalEnv: () => ({
    ORCA_CLAUDE_PROFILE_POINTER: '/orca/claude-profiles/selected-host',
    CLAUDE_CONFIG_DIR: '/orca/claude-profiles/host-selected/home',
    ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/orca/claude-profiles/host-selected/home'
  })
}

async function prepare(args: Partial<RuntimePtySpawnArgs>) {
  const deps = makeRuntimePtySpawnTestDeps()
  const prepareClaudeAuth = vi.fn(async () => ({
    configDir: '/orca/claude-profiles/host-selected/home',
    envPatch: { CLAUDE_CONFIG_DIR: '/orca/claude-profiles/host-selected/home' },
    provenance: 'profile:host-selected'
  }))
  const ctx = createRuntimePtySpawnState(
    {
      ...deps,
      prepareClaudeAuth,
      getSelectedCodexHomePath: () => '/orca/codex-accounts/host-selected/home'
    },
    { cols: 120, rows: 40, cwd: tmpdir(), ...args }
  )
  try {
    await prepareRuntimePtySpawn(ctx)
  } finally {
    ctx.finishTerminalInstall()
  }
  return { ctx, prepareClaudeAuth }
}

afterEach(() => {
  installClaudeProfileRouter(undefined)
})

describe("a caller's own account at spawn on a host with managed accounts", () => {
  it('starts Claude on the caller’s folder, without the host pointer or its auth', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spawn reads only terminalEnv from the installed router.
    installClaudeProfileRouter(hostClaudeRoute as ClaudeProfileRouter)
    const callerAccount = {
      CLAUDE_CONFIG_DIR: '/caller/claude',
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/caller/claude'
    }
    const { ctx, prepareClaudeAuth } = await prepare({
      command: 'claude',
      launchAgent: 'claude',
      env: { ...callerAccount },
      accountEnv: callerAccount
    })
    expect(ctx.env?.CLAUDE_CONFIG_DIR).toBe('/caller/claude')
    expect(ctx.env?.ORCA_CLAUDE_INJECTED_CONFIG_DIR).toBe('/caller/claude')
    expect(ctx.env?.ORCA_CLAUDE_PROFILE_POINTER).toBeUndefined()
    expect(prepareClaudeAuth).not.toHaveBeenCalled()

    const selected = await prepare({ command: 'claude', launchAgent: 'claude' })
    expect(selected.ctx.env?.CLAUDE_CONFIG_DIR).toBe('/orca/claude-profiles/host-selected/home')
    expect(selected.ctx.env?.ORCA_CLAUDE_PROFILE_POINTER).toBe(
      '/orca/claude-profiles/selected-host'
    )
  })

  it('starts and records Codex on the caller’s CODEX_HOME', async () => {
    const { ctx } = await prepare({
      command: 'codex',
      launchAgent: 'codex',
      env: { CODEX_HOME: '/caller/codex' },
      accountEnv: { CODEX_HOME: '/caller/codex' }
    })
    expect(ctx.selectedCodexHomePath).toBe('/caller/codex')

    const selected = await prepare({ command: 'codex', launchAgent: 'codex' })
    expect(selected.ctx.selectedCodexHomePath).toBe('/orca/codex-accounts/host-selected/home')
  })
})
