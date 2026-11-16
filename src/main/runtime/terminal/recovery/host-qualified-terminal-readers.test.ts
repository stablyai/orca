import { describe, expect, it } from 'vitest'
import { restoredPaneStartPlan } from './restored-pane-start'
import { panesBoundToAnotherWorkspace } from './foreign-pane-bindings'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { parsePtySessionId } from '../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { getPtyExecutionHost } from '../../../../shared/terminal/pty/lifecycle/terminal-execution-host'
import { parseAppSshPtyId } from '../../../../shared/remote-runtime/ssh/ssh-pty-id'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'

describe('saved terminal identities from a host-first writer', () => {
  it('retains its workspace binding and selects that exact identity for restore', () => {
    const session = {
      tabsByWorktree: {
        'repo::/project/a': [{ id: 'tab-a' }],
        'repo::/project/b': [{ id: 'tab-b' }]
      },
      terminalLayoutsByTabId: {
        'tab-a': { ptyIdsByLeafId: { 'leaf-a': 'local|repo::/project/a@@saved-a' } },
        'tab-b': { ptyIdsByLeafId: { 'leaf-b': 'local|repo::/project/a@@saved-b' } }
      }
    } as unknown as WorkspaceSessionState

    expect(panesBoundToAnotherWorkspace(session)).toEqual([
      {
        worktreeId: 'repo::/project/b',
        tabId: 'tab-b',
        leafId: 'leaf-b',
        ptyId: 'local|repo::/project/a@@saved-b'
      }
    ])
    expect(
      restoredPaneStartPlan(
        { worktreeId: 'repo::/project/a', tabId: 'tab-a', leafId: 'leaf-a' },
        'local|repo::/project/a@@saved-a'
      )
    ).toEqual({ sessionId: 'local|repo::/project/a@@saved-a' })
  })

  it('reads the host separately from Git and folder workspace identities', () => {
    expect(parsePtySessionId('local|repo::C:\\project\\a|b@@saved')).toEqual({
      worktreeId: 'repo::C:\\project\\a|b'
    })
    expect(parsePtySessionId('local|folder:folder-a@@saved')).toEqual({
      worktreeId: 'folder:folder-a'
    })
    expect(getPtyExecutionHost('local|repo::/project@@saved')).toBe('local')
    expect(getPtyExecutionHost('ssh:target%7Ca|repo::/project@@saved')).toBe('ssh:target%7Ca')
    expect(parseAppSshPtyId('ssh:target%7Ca|relay-9')).toEqual({
      connectionId: 'target|a',
      relayPtyId: 'relay-9'
    })
    expect(parseRemoteRuntimePtyId('runtime:box|term_9')).toEqual({
      environmentId: 'box',
      handle: 'term_9'
    })
  })

  it('keeps legacy workspace paths and remote handles containing a bar intact', () => {
    expect(parsePtySessionId('repo::/project/a|b@@saved')).toEqual({
      worktreeId: 'repo::/project/a|b'
    })
    expect(parseAppSshPtyId('ssh:target@@relay|9')).toEqual({
      connectionId: 'target',
      relayPtyId: 'relay|9'
    })
    expect(parseRemoteRuntimePtyId('remote:box@@term%7C9')).toEqual({
      environmentId: 'box',
      handle: 'term|9'
    })
    expect(
      restoredPaneStartPlan(
        { worktreeId: 'repo::/project', tabId: 'tab', leafId: 'leaf' },
        'repo::/project@@saved'
      )
    ).toEqual({ sessionId: 'repo::/project@@saved' })
  })
})
