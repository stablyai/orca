import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { notifyLocalPtyProviderRebound } from '../../../ipc/pty/provider/local-provider-rebound'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const FOLDER: FolderWorkspace = {
  id: 'notes-1',
  projectGroupId: 'group-1',
  name: 'Notes',
  folderPath: '/fixture/notes',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}
const FOLDER_KEY = folderWorkspaceKey(FOLDER.id)
const LIVE_LEAF = '11111111-1111-4111-8111-111111111111'
const GONE_LEAF = '22222222-2222-4222-8222-222222222222'
const LIVE_PTY = (worktreeId: string) => ({
  id: 'pty-agent',
  cwd: FOLDER.folderPath,
  title: 'claude',
  worktreeId,
  incarnationId: 'inc-1'
})

class PlacementRuntime extends OrcaRuntimeService {
  statusOf(paneKey: string) {
    return this.paneStartStatuses?.peek(paneKey) ?? null
  }
}

function runtimeWithLiveTerminal(
  worktreeId: string,
  live = [LIVE_PTY(worktreeId)],
  session = getDefaultWorkspaceSession()
) {
  const applyLayoutCommand = vi.fn(async (_command: { adopt?: { ptyId: string } }) => ({
    ok: true as const,
    result: { tabId: 'tab-new', leafId: 'leaf-new', paneKey: 'tab-new:leaf-new' }
  }))
  const store = {
    getRepos: () => [],
    getProjectGroups: () => [{ id: 'group-1', parentPath: '/fixture' }],
    getFolderWorkspaces: () => [FOLDER],
    getSettings: () => ({}),
    getAllWorktreeMeta: () => ({}),
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => session,
    applyLayoutCommand
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup pass reads only these store methods.
  const runtime = new PlacementRuntime(store as never)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [...live],
    listProcessesWithHostScope: async () => ({
      processes: [...live],
      hostIds: ['local' as const]
    })
  })
  return { runtime, applyLayoutCommand, live }
}

describe('main’s startup pass over the host census, layout-owner build', () => {
  it('shows a live terminal of a project-group folder workspace in a tab bound to it', async () => {
    const { runtime, applyLayoutCommand } = runtimeWithLiveTerminal(FOLDER_KEY)

    const placement = await runtime.placeUnshownLiveTerminals()

    expect(placement).toEqual({ placed: ['pty-agent'], declined: [] })
    expect(applyLayoutCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'createTerminalTab',
        workspace: FOLDER_KEY,
        adopt: { ptyId: 'pty-agent', incarnationId: 'inc-1' }
      }),
      ['local']
    )
  })

  it('leaves a live terminal of a workspace this host does not know without a tab', async () => {
    const { runtime, applyLayoutCommand } = runtimeWithLiveTerminal('repo-gone::/fixture/gone')

    expect(await runtime.placeUnshownLiveTerminals()).toEqual({ placed: [], declined: [] })
    expect(applyLayoutCommand).not.toHaveBeenCalled()
  })

  it('shows a terminal the replaced terminal service reports, with no client attached', async () => {
    const { runtime, applyLayoutCommand, live } = runtimeWithLiveTerminal(FOLDER_KEY, [])
    await runtime.placeUnshownLiveTerminals()
    expect(applyLayoutCommand).not.toHaveBeenCalled()

    // The terminal service restarted and reports a terminal no pane shows.
    live.push({ ...LIVE_PTY(FOLDER_KEY), id: 'pty-late' })
    notifyLocalPtyProviderRebound()

    await vi.waitFor(() =>
      expect(applyLayoutCommand.mock.calls.map(([command]) => command.adopt?.ptyId)).toEqual([
        'pty-late'
      ])
    )
  })

  it('runs one pass at a time; a call during a pass runs one more pass after it', async () => {
    const { runtime, applyLayoutCommand, live } = runtimeWithLiveTerminal(FOLDER_KEY, [])
    let inFlight = 0
    let overlapped = false
    applyLayoutCommand.mockImplementation(async () => {
      inFlight += 1
      overlapped ||= inFlight > 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { ok: true as const, result: { tabId: 't', leafId: 'l', paneKey: 't:l' } }
    })
    live.push({ ...LIVE_PTY(FOLDER_KEY), id: 'pty-a' })

    const first = runtime.placeUnshownLiveTerminals()
    live.push({ ...LIVE_PTY(FOLDER_KEY), id: 'pty-b' })
    const second = runtime.placeUnshownLiveTerminals()
    await Promise.all([first, second])

    expect(overlapped).toBe(false)
    expect(applyLayoutCommand.mock.calls.map(([command]) => command.adopt?.ptyId)).toContain(
      'pty-b'
    )
  })

  it("starts fresh a pane bound to another workspace's terminal, keeping its own and an SSH one", async () => {
    const own = `${FOLDER_KEY}@@own`
    const other = 'repo-2::/fixture/other@@theirs'
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [FOLDER_KEY]: [
          {
            id: 'tab-1',
            ptyId: own,
            worktreeId: FOLDER_KEY,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split' as const,
            direction: 'vertical' as const,
            first: { type: 'leaf' as const, leafId: 'leaf-own' },
            second: {
              type: 'split' as const,
              direction: 'horizontal' as const,
              first: { type: 'leaf' as const, leafId: 'leaf-other' },
              second: { type: 'leaf' as const, leafId: 'leaf-ssh' }
            }
          },
          activeLeafId: 'leaf-own',
          expandedLeafId: null,
          ptyIdsByLeafId: {
            'leaf-own': own,
            'leaf-other': other,
            'leaf-ssh': 'ssh:ssh-1@@relay-pty'
          }
        }
      }
    }
    const { runtime, applyLayoutCommand } = runtimeWithLiveTerminal(FOLDER_KEY, [], session)

    await runtime.placeUnshownLiveTerminals()

    expect(applyLayoutCommand.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'releasePaneTerminal',
        workspace: FOLDER_KEY,
        tabId: 'tab-1',
        leafId: 'leaf-other',
        ptyId: other
      }
    ])
  })

  it('shows a pane whose local terminal is gone as sleeping, and a live one as nothing', async () => {
    const row = (id: string, ptyId: string) => ({
      id,
      ptyId,
      worktreeId: FOLDER_KEY,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    })
    const layout = (leafId: string, ptyId: string) => ({
      root: { type: 'leaf' as const, leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: ptyId }
    })
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [FOLDER_KEY]: [row('tab-live', 'pty-agent'), row('tab-gone', `${FOLDER_KEY}@@gone`)]
      },
      terminalLayoutsByTabId: {
        'tab-live': layout(LIVE_LEAF, 'pty-agent'),
        'tab-gone': layout(GONE_LEAF, `${FOLDER_KEY}@@gone`)
      }
    }
    const { runtime } = runtimeWithLiveTerminal(FOLDER_KEY, [LIVE_PTY(FOLDER_KEY)], session)
    await runtime.placeUnshownLiveTerminals()

    expect(runtime.statusOf(`tab-gone:${GONE_LEAF}`)).toEqual({ status: 'sleeping' })
    expect(runtime.statusOf(`tab-live:${LIVE_LEAF}`)).toBeNull()
  })
})
