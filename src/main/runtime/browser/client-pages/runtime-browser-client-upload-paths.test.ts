import { describe, expect, it, vi } from 'vitest'
import { routeRuntimeBrowserClientAutomation } from './runtime-browser-client-automation'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'

function uploadTo(files: string[]) {
  const issueClientPageCommand = vi.fn(() => ({
    result: Promise.resolve({ status: 'completed', value: { uploaded: files.length } })
  }))
  const route = routeRuntimeBrowserClientAutomation({
    method: 'browser.upload',
    params: { element: '#f', files, page: 'page-1' },
    caller: undefined,
    pages: {
      getPage: () => ({
        browserPageId: 'page-1',
        workspaceId: 'ws-1',
        placement: {
          browserHostClientId: 'client-a',
          browserHostGeneration: 1,
          pageHostGeneration: 1
        }
      })
    } as unknown as RuntimeBrowserPageRegistry,
    leases: {
      authorityRuntimeId: 'runtime-1',
      authorityEpoch: 1,
      issueClientPageCommand
    } as unknown as BrowserHostLeaseRegistry,
    resolveWorkspace: async () => ({ id: 'ws-1' }),
    resolveWorkspacePath: async () => '/srv/work/app'
  })
  return { route, issueClientPageCommand }
}

describe('browser.upload to a page hosted on another device', () => {
  it('sends workspace-relative paths, since the client reads files through the workspace', async () => {
    const { route, issueClientPageCommand } = uploadTo([
      '/srv/work/app/fixtures/a.png',
      'fixtures/b.png'
    ])
    await route

    expect(issueClientPageCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        params: expect.objectContaining({ files: ['fixtures/a.png', 'fixtures/b.png'] })
      })
    )
  })

  it('refuses a file outside the workspace before reaching the client', async () => {
    const { route, issueClientPageCommand } = uploadTo(['/etc/hosts'])

    await expect(route).rejects.toThrow('Cannot upload /etc/hosts')
    expect(issueClientPageCommand).not.toHaveBeenCalled()
  })
})
