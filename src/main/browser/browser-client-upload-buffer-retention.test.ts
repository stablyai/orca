import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { BrowserClientFileChannelReadParams } from '../../shared/browser-client-file-channel-protocol'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import { createCommand, createHarness } from './browser-client-page-command-executor-test-harness'
import { executeBrowserClientUploadCommand } from './browser-client-upload-command'
import { BrowserClientUploadStaging } from './browser-client-upload-staging'
import {
  BROWSER_CLIENT_FILE_CHANNEL_READ_METHOD,
  readBrowserClientUploadPaths
} from './browser-client-upload-transfer'

const remotePaths = ['docs/first.txt', 'docs/second.txt']
const contents = ['a'.repeat(8193), 'b'.repeat(16385)]
let stagingRoot = ''

beforeEach(async () => {
  stagingRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-upload-buffer-retention-')))
})

afterEach(async () => {
  await rm(stagingRoot, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve = (_value: T): void => {}
  let reject = (_error: unknown): void => {}
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

async function collect(): Promise<void> {
  if (!global.gc) {
    throw new Error('This retention test requires --expose-gc')
  }
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    global.gc()
  }
}

function fileServices(root: string) {
  const buffers: WeakRef<Buffer>[] = []
  let requests = 0
  const staging = new BrowserClientUploadStaging(root, {
    mkdir: async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
    },
    writeFile: async (filePath, bytes) => {
      buffers.push(new WeakRef(bytes))
      await writeFile(filePath, bytes, { mode: 0o600 })
    },
    removeDirectory: async (directory) => {
      await rm(directory, { recursive: true, force: true })
    },
    removeDirectorySync: (directory) => {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  const transport = new BrowserClientFileChannelTransport()
  transport.bind({
    fileChannelNegotiated: true,
    fileChannelAvailability: 'negotiated',
    sendFileChannelRequest: async (method, params) => {
      if (method !== BROWSER_CLIENT_FILE_CHANNEL_READ_METHOD) {
        throw new Error('Unexpected file-channel method')
      }
      const request = BrowserClientFileChannelReadParams.parse(params)
      const source = contents[remotePaths.indexOf(request.workspaceRelativePath)]
      if (source === undefined) {
        throw new Error('Unexpected upload source')
      }
      const chunk = source.slice(request.offset, request.offset + Math.min(request.length, 4096))
      requests += 1
      return {
        id: `read-${requests}`,
        ok: true,
        _meta: { runtimeId: 'runtime-a' },
        result: {
          contentBase64: Buffer.from(chunk).toString('base64'),
          bytesRead: chunk.length,
          totalBytes: source.length,
          eof: request.offset + chunk.length === source.length
        }
      }
    }
  })
  return { buffers, staging, transport, requests: () => requests }
}

async function startUpload(root: string) {
  const services = fileServices(root)
  const harness = createHarness()
  const entered = deferred<void>()
  const finish = deferred<unknown>()
  const localPaths: string[] = []
  const params = { element: '#upload', files: [...remotePaths] }
  const executor = new BrowserClientPageCommandExecutor({
    ...harness.dependencies,
    fileChannel: services.transport,
    uploadStaging: services.staging,
    executeAutomation: (input) => {
      localPaths.push(...readBrowserClientUploadPaths(input.params))
      entered.resolve()
      return finish.promise
    }
  })
  const signal = new AbortController().signal
  const created = await executor.handle(createCommand('createPage'), signal)
  if (created.status !== 'completed') {
    throw new Error('Fixture page creation failed')
  }
  const result = executor.handle(
    createCommand('createPage', {
      commandSequence: 2,
      commandId: 'upload-a',
      command: { type: 'automation', method: 'browser.upload', params }
    }),
    signal
  )
  await entered.promise
  return { ...services, executor, finish, localPaths, params, result }
}

async function expectStagedBytes(localPaths: readonly string[]): Promise<void> {
  expect(localPaths).toHaveLength(2)
  expect(localPaths.map((filePath) => path.basename(filePath))).toEqual(['first.txt', 'second.txt'])
  for (const [index, filePath] of localPaths.entries()) {
    expect(await readFile(filePath, 'utf8')).toBe(contents[index])
  }
}

it.each(['resolve', 'reject', 'page-release'] as const)(
  'releases decoded upload buffers while the guest is pending: %s',
  async (settlement) => {
    const upload = await startUpload(stagingRoot)
    try {
      await collect()
      const pendingBuffers = upload.buffers.filter((buffer) => buffer.deref()).length
      expect(upload.buffers).toHaveLength(2)
      expect(upload.requests()).toBe(8)
      expect(upload.params).toEqual({ element: '#upload', files: remotePaths })
      expect(upload.staging.activeStagingCount()).toBe(1)
      await expectStagedBytes(upload.localPaths)

      if (settlement === 'page-release') {
        expect(await upload.executor.retirePage('page-a', 8)).toBe(false)
        expect(upload.staging.activeStagingCount()).toBe(1)
        expect(await upload.executor.retirePage('page-a', 7)).toBe(true)
        expect(upload.staging.activeStagingCount()).toBe(0)
        expect(upload.localPaths.every((filePath) => !existsSync(filePath))).toBe(true)
      }
      if (settlement === 'reject') {
        upload.finish.reject(new Error('controlled guest failure'))
        await expect(upload.result).resolves.toEqual({
          status: 'failed',
          errorCode: 'browser_client_page_command_failed'
        })
        expect(upload.staging.activeStagingCount()).toBe(0)
        expect(await readdir(stagingRoot)).toHaveLength(0)
      } else {
        upload.finish.resolve({ uploaded: true })
        await expect(upload.result).resolves.toEqual({
          status: 'completed',
          value: { uploaded: true }
        })
        if (settlement === 'resolve') {
          await expectStagedBytes(upload.localPaths)
          expect(await upload.executor.retirePage('page-a', 7)).toBe(true)
        }
      }
      expect(upload.params.files).toEqual(remotePaths)
      expect(await readdir(stagingRoot)).toHaveLength(0)
      expect(pendingBuffers).toBe(0)
    } finally {
      upload.finish.resolve(undefined)
      await upload.result
      await upload.executor.close()
    }
  }
)

it('keeps the original guest error and caller paths when a staged upload fails', async () => {
  const services = fileServices(stagingRoot)
  const params = { element: '#upload', files: [...remotePaths] }
  const failure = new Error('controlled guest failure')
  await expect(
    executeBrowserClientUploadCommand({
      event: createCommand('createPage', {
        command: { type: 'automation', method: 'browser.upload', params }
      }),
      params,
      fileChannel: services.transport,
      staging: services.staging,
      run: async (rewritten) => {
        expect(rewritten).not.toBe(params)
        await expectStagedBytes(readBrowserClientUploadPaths(rewritten))
        throw failure
      }
    })
  ).rejects.toBe(failure)
  expect(params).toEqual({ element: '#upload', files: remotePaths })
  expect(services.staging.activeStagingCount()).toBe(0)
  expect(await readdir(stagingRoot)).toHaveLength(0)
})
