import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type * as FileSystemPromises from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFilesystemHandlerContext } from '../filesystem-handler-context'
import { createSenderScopedRequestCancellations } from '../../renderer-requests/sender-scoped-request-cancellation'
import { registerFilesystemDownloadHandlers } from './filesystem-download-handlers'

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  destination: '',
  raceDestination: '',
  inspected: 0,
  inspectedBoth: Promise.resolve(),
  releaseInspections: () => {},
  failWrite: false
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: boundary.destination })
  },
  ipcMain: {
    handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
      boundary.handlers.set(channel, handler)
    }
  }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystemPromises>()
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      try {
        return await fs.stat(...args)
      } catch (error) {
        if (
          args[0] === boundary.raceDestination &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          boundary.inspected += 1
          if (boundary.inspected === 2) {
            boundary.releaseInspections()
          }
          await boundary.inspectedBoth
        }
        throw error
      }
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args)
      if (boundary.failWrite) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      }
    }
  }
})

let directory: string
let context: ReturnType<typeof createFilesystemHandlerContext>
let event: IpcMainInvokeEvent

function invoke(channel: string, args: Record<string, string>): Promise<unknown> {
  const handler = boundary.handlers.get(channel)
  if (!handler) {
    throw new Error(`Missing download handler: ${channel}`)
  }
  return Promise.resolve(handler(event, args))
}

async function startDownload(suggestedName: string): Promise<{ transferId: string }> {
  const result = await invoke('fs:startDownloadedFile', { suggestedName })
  if (
    typeof result !== 'object' ||
    result === null ||
    !('transferId' in result) ||
    typeof result.transferId !== 'string'
  ) {
    throw new Error('Download did not start')
  }
  return { transferId: result.transferId }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-download-custody-'))
  boundary.handlers.clear()
  boundary.destination = join(directory, 'saved.txt')
  boundary.raceDestination = ''
  boundary.inspected = 0
  boundary.inspectedBoth = Promise.resolve()
  boundary.releaseInspections = () => {}
  boundary.failWrite = false
  context = createFilesystemHandlerContext(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only download handlers are registered; none access the store.
    {} as Parameters<typeof createFilesystemHandlerContext>[0],
    undefined,
    createSenderScopedRequestCancellations(),
    createSenderScopedRequestCancellations()
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Download handlers only use the sender event methods and isDestroyed supplied here.
  event = {
    sender: Object.assign(new EventEmitter(), { isDestroyed: () => false })
  } as IpcMainInvokeEvent
  registerFilesystemDownloadHandlers(context)
})

afterEach(async () => {
  for (const transferId of context.downloadSessions.keys()) {
    await context.closeDownloadSession(transferId, true)
  }
  await rm(directory, { recursive: true, force: true })
})

it('retains both complete payloads when concurrent save requests claim the same new destination', async () => {
  boundary.raceDestination = boundary.destination
  boundary.inspectedBoth = new Promise<void>((resolve) => {
    boundary.releaseInspections = resolve
  })
  const results = await Promise.allSettled([
    invoke('fs:saveDownloadedFile', { suggestedName: 'saved.txt', content: 'first download' }),
    invoke('fs:saveDownloadedFile', { suggestedName: 'saved.txt', content: 'second download' })
  ])
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  const retained = (await readdir(directory)).filter((name) => name.endsWith('.download'))
  expect(retained).toHaveLength(1)
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { message: expect.stringContaining(join(directory, retained[0])) }
  })
  expect(
    [
      await readFile(boundary.destination, 'utf8'),
      await readFile(join(directory, retained[0]), 'utf8')
    ].sort()
  ).toEqual(['first download', 'second download'])

  boundary.raceDestination = ''
  boundary.destination = join(directory, 'failed.txt')
  boundary.failWrite = true
  await expect(
    invoke('fs:saveDownloadedFile', { suggestedName: 'failed.txt', content: 'incomplete' })
  ).rejects.toThrow('disk full')
  expect((await readdir(directory)).sort()).toEqual([...retained, 'saved.txt'].sort())
})

it('preserves a completed losing stream through finish failure and the renderer cancellation', async () => {
  const first = await startDownload('saved.txt')
  const second = await startDownload('saved.txt')
  await invoke('fs:appendDownloadedFileChunk', {
    transferId: first.transferId,
    contentBase64: Buffer.from('first stream').toString('base64')
  })
  await invoke('fs:appendDownloadedFileChunk', {
    transferId: second.transferId,
    contentBase64: Buffer.from('second stream').toString('base64')
  })
  await expect(invoke('fs:finishDownloadedFile', first)).resolves.toEqual({
    canceled: false,
    destinationPath: boundary.destination
  })
  await expect(invoke('fs:finishDownloadedFile', second)).rejects.toThrow(
    'Destination file appeared before download completed'
  )
  await invoke('fs:cancelDownloadedFile', second)
  const retained = (await readdir(directory)).filter((name) => name.endsWith('.download'))
  expect(retained).toHaveLength(1)
  expect(await readFile(boundary.destination, 'utf8')).toBe('first stream')
  expect(await readFile(join(directory, retained[0]), 'utf8')).toBe('second stream')

  boundary.destination = join(directory, 'canceled.txt')
  const canceled = await startDownload('canceled.txt')
  await invoke('fs:appendDownloadedFileChunk', {
    transferId: canceled.transferId,
    contentBase64: Buffer.from('canceled stream').toString('base64')
  })
  await invoke('fs:cancelDownloadedFile', canceled)
  expect((await readdir(directory)).sort()).toEqual([...retained, 'saved.txt'].sort())
})
