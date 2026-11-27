import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'
import { createSenderScopedRequestCancellations } from '../renderer-requests/sender-scoped-request-cancellation'
import { createFilesystemHandlerContext } from './filesystem-handler-context'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('fails a finish whose staged file reports a lost write on close, and removes it', async () => {
  const context = createFilesystemHandlerContext(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: closing a download session never reads the store.
    {} as Store,
    undefined,
    createSenderScopedRequestCancellations(),
    createSenderScopedRequestCancellations()
  )
  const dir = await mkdtemp(path.join(tmpdir(), 'orca-download-close-'))
  dirs.push(dir)
  const tempPath = path.join(dir, 'report.pdf.download')
  const handle = await open(tempPath, 'wx')
  await handle.writeFile('downloaded bytes')
  const close = handle.close.bind(handle)
  handle.close = async () => {
    await close()
    throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' })
  }
  context.downloadSessions.set('finish', {
    destinationPath: path.join(dir, 'report.pdf'),
    tempPath,
    destinationExisted: false,
    handle,
    cleanupTimer: setTimeout(() => {}, 0),
    disposeRendererLifetime: () => {}
  })

  await expect(context.closeDownloadSession('finish', false)).rejects.toThrow(
    'EIO: i/o error, close'
  )
  expect(context.downloadSessions.has('finish')).toBe(false)
  await expect(stat(tempPath)).rejects.toMatchObject({ code: 'ENOENT' })
})
