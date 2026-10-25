import { describe, expect, it, vi } from 'vitest'
import { openMobileFileTap } from './mobile-file-tap-open'

function ok(result: unknown) {
  return { ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function createClient(responses: unknown[]) {
  return {
    sendRequest: vi.fn(async () => responses.shift())
  }
}

function activeTerminalState(activated: boolean) {
  return {
    activated,
    activationSeq: 1,
    latestActivationSeq: 1,
    sourceTerminalHandle: 'terminal-1',
    activeTerminalHandle: 'terminal-1',
    activeTabType: 'terminal'
  }
}

describe('resolveMissingTerminalFileTap', () => {
  it('retries without terminal handle when OSC7 terminalCwd produced a UNC path and resolves bare filenames via worktree.ps file:// links', async () => {
    const client = createClient([
      ok({
        worktree: 'wt-bin',
        relativePath: null,
        absolutePath: '//laptop-frkp0d5j/c/Users/me/.local/bin/grok_shanghai_prob.md',
        exists: false,
        isDirectory: false
      }),
      ok({
        worktree: 'wt-bin',
        relativePath: null,
        absolutePath: 'C:/Users/me/.local/bin/grok_shanghai_prob.md',
        exists: false,
        isDirectory: false
      }),
      ok({
        worktrees: [
          {
            worktreeId: 'wt-bin',
            lastActivityAt: 100,
            agents: [
              {
                paneKey: 'pane-1',
                lastAssistantMessage:
                  '产物：[grok_shanghai_prob.md](file:///C:/Users/me/.gemini/antigravity-cli/brain/e000/scratch/grok_shanghai_prob.md)'
              }
            ]
          }
        ]
      }),
      ok({
        worktree: 'folder:gemini-root',
        relativePath: 'antigravity-cli/brain/e000/scratch/grok_shanghai_prob.md',
        absolutePath: 'C:/Users/me/.gemini/antigravity-cli/brain/e000/scratch/grok_shanghai_prob.md',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'antigravity-cli/brain/e000/scratch/grok_shanghai_prob.md',
          absolutePath:
            'C:/Users/me/.gemini/antigravity-cli/brain/e000/scratch/grok_shanghai_prob.md'
        }
      })
    ])
    const pushPreviewRoute = vi.fn()

    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-bin',
      pathText: 'grok_shanghai_prob.md',
      terminalHandle: 'terminal-1',
      line: null,
      column: null,
      pushPreviewRoute,
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => null,
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve()
    }

    expect(pushPreviewRoute).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: expect.objectContaining({
        hostId: 'host-1',
        worktreeId: 'folder:gemini-root',
        source: 'worktree',
        relativePath: 'antigravity-cli/brain/e000/scratch/grok_shanghai_prob.md',
        name: 'grok_shanghai_prob.md'
      })
    })
  })
})
