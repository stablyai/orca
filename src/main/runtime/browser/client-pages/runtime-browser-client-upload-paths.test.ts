import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { routeRuntimeBrowserClientAutomation } from './runtime-browser-client-automation'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'

function uploadTo(files: string[], workspacePath = '/srv/work/app') {
  const issueClientPageCommand = vi.fn(() => ({
    result: Promise.resolve({ status: 'completed', value: { uploaded: files.length } })
  }))
  const route = routeRuntimeBrowserClientAutomation({
    method: 'browser.upload',
    params: { element: '#f', files, page: 'page-1' },
    caller: undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the upload route reads only getPage from the registry.
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the upload route reads only authority ids and issueClientPageCommand.
    leases: {
      authorityRuntimeId: 'runtime-1',
      authorityEpoch: 1,
      issueClientPageCommand
    } as unknown as BrowserHostLeaseRegistry,
    resolveWorkspace: async () => ({ id: 'ws-1' }),
    resolveWorkspacePath: async () => workspacePath
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

  it('matches a workspace saved under a symlink against the physical file path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-upload-root-'))
    try {
      mkdirSync(join(dir, 'real', 'fixtures'), { recursive: true })
      writeFileSync(join(dir, 'real', 'fixtures', 'a.png'), '')
      symlinkSync(join(dir, 'real'), join(dir, 'link'), 'junction')
      const physical = join(realpathSync(dir), 'real', 'fixtures', 'a.png')
      const { route, issueClientPageCommand } = uploadTo([physical], join(dir, 'link'))
      await route

      expect(issueClientPageCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          params: expect.objectContaining({ files: ['fixtures/a.png'] })
        })
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a file outside the workspace before reaching the client', async () => {
    const { route, issueClientPageCommand } = uploadTo(['/srv/work/app/../../../etc/hosts'])

    await expect(route).rejects.toThrow('Cannot upload /srv/work/app/../../../etc/hosts')
    expect(issueClientPageCommand).not.toHaveBeenCalled()
  })
})
