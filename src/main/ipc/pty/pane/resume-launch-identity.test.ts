import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedResumeLaunchIdentityFromSpawn } from './resume-launch-identity'

const { recordLaunchResumeIdentity } = vi.hoisted(() => ({
  recordLaunchResumeIdentity: vi.fn()
}))

vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { recordLaunchResumeIdentity }
}))

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const LAUNCHED_AT = new Date(1_000)

function seed(overrides: Partial<Parameters<typeof seedResumeLaunchIdentityFromSpawn>[0]> = {}) {
  seedResumeLaunchIdentityFromSpawn({
    paneKey: PANE_KEY,
    launchAgent: 'codex',
    resumeProviderSession: { key: 'session_id', id: 'codex-session' },
    connectionId: null,
    worktreeId: 'wt-1',
    launchedAt: LAUNCHED_AT,
    resumeArgvDropped: false,
    result: { id: 'pty-1' },
    ...overrides
  })
}

describe('seedResumeLaunchIdentityFromSpawn', () => {
  beforeEach(() => {
    recordLaunchResumeIdentity.mockReset()
  })

  it('records the resumed session of a fresh local launch', () => {
    seed()
    expect(recordLaunchResumeIdentity).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'codex-session' },
      launchedAt: 1_000
    })
  })

  it.each([
    ['a reattached process', { result: { id: 'pty-1', isReattach: true } }],
    ['a Codex resume that fell back to a fresh session', { resumeArgvDropped: true }],
    ['an SSH pane, whose relay owns its rows', { connectionId: 'ssh-1' }],
    ['a launch with no resume', { resumeProviderSession: undefined }],
    ['a malformed resume id', { resumeProviderSession: { key: 'session_id', id: '-rf' } }],
    ['an agent that cannot resume', { launchAgent: 'not-an-agent' }],
    ['a Pi resume without its transcript file', { launchAgent: 'pi' }],
    ['a spawn with no pane key', { paneKey: null }]
  ])('skips %s', (_label, overrides) => {
    seed(overrides)
    expect(recordLaunchResumeIdentity).not.toHaveBeenCalled()
  })
})
