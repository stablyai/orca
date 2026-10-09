// A headless automation launches on an existing workspace through launchAgentTerminal; agents that
// read their prompt after they start never got it because the startup follow-up was dropped.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

import { OrcaRuntimeService } from './orca-runtime'

function makeRuntime() {
  const repo = { id: 'repo-1', path: '/home/me/app' }
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only these protected members; each is assigned or stubbed before launchAgentTerminal runs.
  const internals = runtime as unknown as {
    store: Record<string, unknown>
    resolveWorktreeSelector: (selector: string) => Promise<unknown>
    createTerminal: (selector: string, opts: unknown) => Promise<unknown>
    sendStartupFollowupWhenReady: (handle: string, followup: unknown) => void
  }
  internals.store = {
    getSettings: () => ({ disabledTuiAgents: [], workspaceDir: '/tmp/workspaces' }),
    getProjectHostSetups: () => [],
    getRepos: () => [repo],
    getRepo: (id: string) => (id === repo.id ? repo : undefined)
  }
  vi.spyOn(internals, 'resolveWorktreeSelector').mockResolvedValue({
    id: 'repo-1::/home/me/app-feature',
    repoId: 'repo-1',
    path: '/home/me/app-feature'
  })
  const createTerminal = vi.spyOn(internals, 'createTerminal').mockResolvedValue({
    handle: 'term_x',
    worktreeId: 'repo-1::/home/me/app-feature',
    title: null
  })
  const sendFollowup = vi
    .spyOn(internals, 'sendStartupFollowupWhenReady')
    .mockImplementation(() => undefined)
  return { runtime, createTerminal, sendFollowup }
}

describe('launchAgentTerminal startup follow-up', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('types the prompt into an agent that reads it after it starts', async () => {
    const { runtime, sendFollowup } = makeRuntime()

    const terminal = await runtime.launchAgentTerminal('id:repo-1::/home/me/app-feature', {
      agent: 'aider',
      prompt: 'fix the flaky test'
    })

    expect(terminal).toMatchObject({ handle: 'term_x' })
    expect(sendFollowup).toHaveBeenCalledTimes(1)
    expect(sendFollowup).toHaveBeenCalledWith(
      'term_x',
      expect.objectContaining({ prompt: 'fix the flaky test' })
    )
  })

  it('sends no follow-up when the prompt rides on the launch command', async () => {
    const { runtime, createTerminal, sendFollowup } = makeRuntime()

    await runtime.launchAgentTerminal('id:repo-1::/home/me/app-feature', {
      agent: 'claude',
      prompt: 'fix the flaky test'
    })

    expect(createTerminal).toHaveBeenCalledTimes(1)
    expect(sendFollowup).not.toHaveBeenCalled()
  })
})
