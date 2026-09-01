import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsHandler } from './fs-handler'

const fixtureRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('FsHandler document previews', () => {
  it('registers an execution-host read that rejects canonical symlink escapes', async () => {
    const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    const dispatcher = {
      onRequest: vi.fn(
        (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          requestHandlers.set(method, handler)
        }
      ),
      onNotification: vi.fn(),
      onClientDetached: vi.fn(),
      notify: vi.fn(),
      notifyClient: vi.fn()
    }
    new FsHandler(dispatcher as never, {} as never)
    const readDocPreview = requestHandlers.get('fs.readDocPreview')
    expect(readDocPreview).toBeTypeOf('function')

    const fixture = await mkdtemp(join(tmpdir(), 'orca-relay-doc-preview-'))
    fixtureRoots.push(fixture)
    const workspace = join(fixture, 'workspace')
    const docs = join(workspace, 'docs')
    const outside = join(fixture, 'outside')
    await Promise.all([mkdir(docs, { recursive: true }), mkdir(outside)])
    const entryPath = join(docs, 'index.html')
    await writeFile(entryPath, '<h1>entry</h1>')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const linkedOutside = join(docs, 'linked')
    await symlink(outside, linkedOutside, process.platform === 'win32' ? 'junction' : 'dir')
    const request = {
      boundaryPath: workspace,
      entryPath,
      implicitRootPath: docs,
      authorizedRootPaths: [],
      maxTextBytes: 1024,
      maxBinaryBytes: 1024
    }

    await expect(readDocPreview!({ ...request, targetPath: entryPath })).resolves.toEqual({
      content: '<h1>entry</h1>',
      isBinary: false
    })
    await expect(
      readDocPreview!({ ...request, targetPath: join(linkedOutside, 'secret.txt') })
    ).rejects.toThrow('doc_preview_path_unauthorized')
  })
})
