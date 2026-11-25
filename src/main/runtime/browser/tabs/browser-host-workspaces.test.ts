import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { runInRemoteCliBrowserScope } from '../../desktop-browser-bridge/remote-cli-browser-scope'
import { resolveBrowserHostWorkspaceSelector } from './browser-host-workspaces'

const SSH_WORKSPACE = 'repo-on-ssh-host::/home/me/app'

function snapshot(pageIds: string[]): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: SSH_WORKSPACE,
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    browserPageInventory: pageIds.map((browserPageId) => ({
      browserPageId,
      browserWorkspaceId: 'browser-workspace',
      title: 'Page',
      url: 'https://example.com/',
      profileId: null,
      loadError: null,
      certificateFailure: null
    }))
  }
}

const notInCatalog = (): Promise<{ id: string }> => Promise.reject(new Error('selector_not_found'))

describe('resolveBrowserHostWorkspaceSelector', () => {
  it('serves a workspace another runtime owns only while this window renders pages there', async () => {
    await expect(
      resolveBrowserHostWorkspaceSelector(
        `id:${SSH_WORKSPACE}`,
        notInCatalog,
        new Map([[SSH_WORKSPACE, snapshot(['page-1'])]])
      )
    ).resolves.toEqual({ id: SSH_WORKSPACE })

    await expect(
      resolveBrowserHostWorkspaceSelector(
        `id:${SSH_WORKSPACE}`,
        notInCatalog,
        new Map([[SSH_WORKSPACE, snapshot([])]])
      )
    ).rejects.toThrow('selector_not_found')
  })

  it('never widens an SSH host command scoped to another workspace', async () => {
    await expect(
      runInRemoteCliBrowserScope('other-workspace', () =>
        resolveBrowserHostWorkspaceSelector(
          `id:${SSH_WORKSPACE}`,
          notInCatalog,
          new Map([[SSH_WORKSPACE, snapshot(['page-1'])]])
        )
      )
    ).rejects.toThrow('An SSH host can only reach browser tabs in its own workspaces.')
  })
})
