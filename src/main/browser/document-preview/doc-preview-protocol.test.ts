import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readAuthorizedDocPreviewFile,
  readAuthorizedDocPreviewFileChunk
} from '../../../shared/document-preview/doc-preview-file-access'
import type { RuntimeDocPreviewReadParams } from './doc-preview-runtime-read-contract'

const mocks = vi.hoisted(() => ({ callRuntimeEnvironment: vi.fn() }))

vi.mock('electron', () => ({ protocol: {}, session: {} }))
vi.mock('../../ipc/runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('../../ipc/runtime-environments/catalog/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/user-data'
}))

import { handleDocPreviewRequest } from './doc-preview-protocol'
import { mintDocPreviewGrant, revokeAllDocPreviewGrants } from './doc-preview-grant-registry'

let workspace = ''

// Only the network hop is faked: the paired host's real readers answer each RPC.
function serveFromHost(): void {
  mocks.callRuntimeEnvironment.mockImplementation(
    async (
      _root,
      _env,
      method: string,
      params: RuntimeDocPreviewReadParams & { offset?: number; length?: number; media?: boolean }
    ) => {
      const target = {
        boundaryPath: workspace,
        entryPath: join(workspace, params.entryRelativePath),
        implicitRootPath:
          params.implicitRootRelativePath === null
            ? null
            : join(workspace, params.implicitRootRelativePath),
        authorizedRootPaths: params.authorizedRootRelativePaths.map((root) =>
          join(workspace, root)
        ),
        targetPath: join(workspace, params.relativePath)
      }
      try {
        const result =
          method === 'files.readDocPreviewChunk'
            ? await readAuthorizedDocPreviewFileChunk(
                { ...target, media: params.media },
                params.offset!,
                params.length!
              )
            : await readAuthorizedDocPreviewFile({
                ...target,
                maxTextBytes: 512 * 1024,
                maxBinaryBytes: 10 * 1024 * 1024
              })
        return { ok: true, result }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'runtime_error',
            message: error instanceof Error ? error.message : String(error)
          }
        }
      }
    }
  )
}

function previewRequest(grantId: string, path: string, range?: string): Request {
  return new Request(`orca-preview://${grantId}/${path}`, {
    headers: range ? { Range: range } : {}
  })
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'orca-doc-preview-media-'))
  await mkdir(join(workspace, 'docs'), { recursive: true })
  await writeFile(join(workspace, 'docs', 'index.html'), '<video src="clip.mp4"></video>')
  serveFromHost()
})

afterEach(async () => {
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
  await rm(workspace, { recursive: true, force: true })
})

describe('handleDocPreviewRequest — media in a paired workspace page', () => {
  it('streams a video next to the page by byte range, across host chunks', async () => {
    const video = Buffer.from(Array.from({ length: 600 * 1024 }, (_, index) => index % 251))
    await writeFile(join(workspace, 'docs', 'clip.mp4'), video)
    const grant = mintDocPreviewGrant({
      owner: {
        kind: 'runtime',
        environmentId: 'env-1',
        worktreeSelector: 'id:wt-1',
        worktreeRoot: workspace
      },
      requestBase: workspace,
      root: join(workspace, 'docs'),
      entryRelativePath: 'docs/index.html',
      browserPageId: 'page-1'
    })

    const response = await handleDocPreviewRequest(
      previewRequest(grant.id, 'docs/clip.mp4', 'bytes=100-')
    )

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Type')).toBe('video/mp4')
    expect(response.headers.get('Content-Range')).toBe('bytes 100-614399/614400')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(video.subarray(100))
  })
})
