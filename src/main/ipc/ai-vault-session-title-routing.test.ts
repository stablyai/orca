import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'
import { rememberLaunchFilePrompt } from '../agent-hooks/launch-file-prompt-by-pane'
import { carryInLaunchFile, buildLaunchFilePointer } from '../../shared/launch-prompt-file'
import { resolveAiVaultSessionTitlesByHost } from './ai-vault-session-title-routing'
import { requestActiveSshAiVaultSessionTitles } from './ssh'

vi.mock('../ai-vault/session-title-resolver', () => ({
  resolveLocalAiVaultSessionTitles: vi.fn()
}))
vi.mock('./ssh', () => ({ requestActiveSshAiVaultSessionTitles: vi.fn() }))

const PANE = 'tab-title:11111111-1111-4111-8111-111111111111'
// The transcript's first message is the pointer; its title is cut to 96 characters.
const POINTER_TITLE = buildLaunchFilePointer(
  '/Users/ada/Library/Caches/orca-launch-file-1-a/task-context.md'
).slice(0, 96)

// Why: a launch file's agent opens its transcript with Orca's pointer, and the tab label and the
// sidebar agent row read the session title from it (stack QA 1.2).
describe('a session title for a launch file’s agent', () => {
  beforeEach(() => {
    rememberLaunchFilePrompt(PANE, carryInLaunchFile('QA-STACK fix the flaky test').launchFile)
  })

  it('shows the prompt the launch file carried, not the pointer', async () => {
    vi.mocked(resolveLocalAiVaultSessionTitles).mockResolvedValue({
      titles: [{ agent: 'claude', sessionId: 's-1', title: POINTER_TITLE }]
    })
    const result = await resolveAiVaultSessionTitlesByHost({
      requests: [{ agent: 'claude', sessionId: 's-1', paneKey: PANE }]
    })
    expect(result.titles).toEqual([
      { agent: 'claude', sessionId: 's-1', title: 'QA-STACK fix the flaky test' }
    ])
  })

  it('leaves another pane’s title, and a request without a pane, as the transcript has it', async () => {
    vi.mocked(resolveLocalAiVaultSessionTitles).mockResolvedValue({
      titles: [
        { agent: 'claude', sessionId: 's-2', title: POINTER_TITLE },
        { agent: 'codex', sessionId: 's-3', title: 'fix the build' }
      ]
    })
    const result = await resolveAiVaultSessionTitlesByHost({
      requests: [
        { agent: 'claude', sessionId: 's-2' },
        { agent: 'codex', sessionId: 's-3', paneKey: PANE }
      ]
    })
    expect(result.titles.map((title) => title.title)).toEqual([POINTER_TITLE, 'fix the build'])
  })

  it('maps an SSH session’s title here, never sending the relay this host’s pane', async () => {
    vi.mocked(requestActiveSshAiVaultSessionTitles).mockResolvedValue({
      titles: [{ agent: 'claude', sessionId: 's-4', title: POINTER_TITLE }]
    })
    const result = await resolveAiVaultSessionTitlesByHost({
      executionHostScope: 'ssh:dev-box',
      requests: [{ agent: 'claude', sessionId: 's-4', paneKey: PANE }]
    })
    expect(requestActiveSshAiVaultSessionTitles).toHaveBeenCalledWith('dev-box', {
      requests: [{ agent: 'claude', sessionId: 's-4' }]
    })
    expect(result.titles[0]?.title).toBe('QA-STACK fix the flaky test')
  })
})
