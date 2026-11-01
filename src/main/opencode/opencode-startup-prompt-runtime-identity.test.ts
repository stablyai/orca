import { describe, expect, it, vi } from 'vitest'
import { OpenCodeStartupPromptClaims } from './opencode-startup-prompt-claims'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../runtime/agent-transcript-pane-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

async function fixture(launchAgent?: 'opencode' | 'opencode2' | 'zcode') {
  const { runtime } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: null,
    data: '',
    ...(launchAgent ? { launchAgent } : {})
  })
  runtime.terminalRunFacts.recordSpawnCommit({ id: TRANSCRIPT_PANE_PTY_ID, incarnationId: 'inc-1' })
  const read = (
    ptyId = TRANSCRIPT_PANE_PTY_ID,
    incarnation = 'inc-1',
    token = 'transcript-launch'
  ) => runtime.readOpenCodeStartupPromptOwner(ptyId, incarnation, token)
  return { runtime, read }
}

describe('runtime-owned startup prompt identity', () => {
  it('refuses same-ID replay after the execution owner or launch token changes', async () => {
    const f = await fixture('opencode2')
    const claims = new OpenCodeStartupPromptClaims()
    claims.register('owned-operation', 'digest', () => f.read())
    const body = { nonce: 'owned-operation', digest: 'digest', requestId: 'stable-operation' }
    expect(claims.claim(body)).toBe(true)
    expect(claims.claim(body)).toBe(true)
    await f.runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0, 'inc-1')
    f.runtime.registerPty(TRANSCRIPT_PANE_PTY_ID, 'wt-1', null, {
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      incarnationId: 'inc-2',
      agentLaunchAuthority: { launchToken: 'replacement-launch', launchAgent: 'opencode2' }
    })
    f.runtime.terminalRunFacts.recordSpawnCommit({
      id: TRANSCRIPT_PANE_PTY_ID,
      incarnationId: 'inc-2'
    })
    expect(f.read(TRANSCRIPT_PANE_PTY_ID, 'inc-2', 'replacement-launch')).toEqual({
      freshSpawn: true,
      firstUserInputAt: null
    })
    expect(f.read(TRANSCRIPT_PANE_PTY_ID, 'inc-2', 'transcript-launch')).toBeNull()
    expect(claims.claim(body)).toBe(false)
    claims.clear()
  })
})
