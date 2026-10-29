import { describe, expect, it, vi } from 'vitest'
import type { ClaudeSession } from './structured/claude-structured-session-state'
import { applyClaudeLivePermissionMode } from './claude-structured-live-permission'
import { claudeModelTransitionRestart } from './claude-structured-options'

function session(setPermissionMode: (mode: string) => Promise<void>) {
  const openingInit: { permissionMode: string | null } = { permissionMode: 'default' }
  const fake = {
    fence: 1,
    connection: { setPermissionMode: vi.fn(setPermissionMode) },
    launchIntent: { model: 'opus', permissionMode: 'auto' },
    firstRootInit: openingInit
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch and the restart check read only these fields.
  return { fake, openingInit, session: fake as unknown as ClaudeSession }
}

describe('switching a running Claude agent to a new permission mode', () => {
  it('sends the CLI mode with a short timeout and records that the agent now runs it', async () => {
    const { fake, session: claude } = session(async () => {})
    await expect(applyClaudeLivePermissionMode(claude, 'full-access')).resolves.toBe(true)
    expect(fake.connection.setPermissionMode).toHaveBeenCalledWith('bypassPermissions', {
      timeoutMs: 5_000
    })
    expect(fake.launchIntent).toEqual({ model: 'opus', permissionMode: 'bypassPermissions' })
    expect(fake.firstRootInit).toEqual({ permissionMode: 'bypassPermissions' })
  })

  it('keeps a later model pick from reopening the agent after the next turn opens', async () => {
    const { fake, openingInit, session: claude } = session(async () => {})
    const sessions = new Map([['session-1', claude]])
    const restarts = claudeModelTransitionRestart(sessions)
    const modelPick = { sessionId: 'session-1', fence: 1, executionOptions: { model: 'sonnet' } }
    // Launched in Auto, opened in Ask: a model pick would reopen it to drop that fallback.
    expect(restarts(modelPick)).toBe(true)

    await applyClaudeLivePermissionMode(claude, 'accept-edits')
    // Acquisition re-adopts its captured opening init on each turn's root init.
    fake.firstRootInit = openingInit
    expect(restarts(modelPick)).toBe(false)
  })

  it('leaves a refused mode and own settings to the next start', async () => {
    const { fake, session: claude } = session(async () => {
      throw new Error('Cannot set permission mode to bypassPermissions')
    })
    await expect(applyClaudeLivePermissionMode(claude, 'full-access')).resolves.toBe(false)
    await expect(applyClaudeLivePermissionMode(claude, 'own')).resolves.toBe(false)
    await expect(applyClaudeLivePermissionMode(undefined, 'ask')).resolves.toBe(false)
    expect(fake.connection.setPermissionMode).toHaveBeenCalledTimes(1)
    expect(fake.launchIntent.permissionMode).toBe('auto')
  })
})
