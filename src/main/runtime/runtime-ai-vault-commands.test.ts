import { describe, expect, it, vi } from 'vitest'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'
import { rememberLaunchFilePrompt } from '../agent-hooks/launch-file-prompt-by-pane'
import { buildLaunchFilePointer, carryInLaunchFile } from '../../shared/launch-prompt-file'
import { RuntimeAiVaultCommands } from './runtime-ai-vault-commands'

vi.mock('../ai-vault/cached-session-list', () => ({ listAiVaultSessions: vi.fn() }))
vi.mock('../ai-vault/session-title-resolver', () => ({
  resolveLocalAiVaultSessionTitles: vi.fn()
}))

// Why: a paired web client and the phone ask this host for titles over RPC; the host spawned the
// pane, so it shows the launch file's prompt there too.
describe('session titles a paired client asks this host for', () => {
  it('show a launch file’s prompt, not the pointer its transcript opens with', async () => {
    const pane = 'tab-rpc:22222222-2222-4222-8222-222222222222'
    rememberLaunchFilePrompt(pane, carryInLaunchFile('QA-STACK review the diff').launchFile)
    vi.mocked(resolveLocalAiVaultSessionTitles).mockResolvedValue({
      titles: [
        {
          agent: 'codex',
          sessionId: 's-rpc',
          title: buildLaunchFilePointer('/tmp/orca-launch-file-1-b/task-context.md').slice(0, 96)
        }
      ]
    })
    const result = await new RuntimeAiVaultCommands(() => null).resolveTitles([
      { agent: 'codex', sessionId: 's-rpc', paneKey: pane }
    ])
    expect(result.titles[0]?.title).toBe('QA-STACK review the diff')
  })
})
