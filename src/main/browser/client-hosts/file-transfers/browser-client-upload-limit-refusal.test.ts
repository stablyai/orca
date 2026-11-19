import { rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { BrowserClientPageCommandExecutor } from '../../client-pages/execution/browser-client-page-command-executor'
import {
  createCommand,
  createHarness
} from '../../client-pages/execution/browser-client-page-command-executor-test-harness'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import { BrowserClientUploadStaging } from './browser-client-upload-staging'

let stagingRoot = ''

beforeEach(async () => {
  stagingRoot = await mkdtemp(path.join(tmpdir(), 'orca-upload-limit-refusal-'))
})

afterEach(async () => {
  await rm(stagingRoot, { recursive: true, force: true })
})

it('refuses an upload of too many files with its own code before reading any file', async () => {
  const sendFileChannelRequest = vi.fn(async () => {
    throw new Error('No file should be read')
  })
  const transport = new BrowserClientFileChannelTransport()
  transport.bind({
    fileChannelNegotiated: true,
    fileChannelAvailability: 'negotiated',
    sendFileChannelRequest
  })
  const staging = new BrowserClientUploadStaging(stagingRoot, {
    mkdir: async () => {
      throw new Error('Nothing should be staged')
    },
    writeFile: async () => {
      throw new Error('Nothing should be staged')
    },
    removeDirectory: async (directory) => {
      await rm(directory, { recursive: true, force: true })
    },
    removeDirectorySync: (directory) => {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  const executeAutomation = vi.fn()
  const executor = new BrowserClientPageCommandExecutor({
    ...createHarness().dependencies,
    fileChannel: transport,
    uploadStaging: staging,
    executeAutomation
  })
  const signal = new AbortController().signal
  try {
    expect(await executor.handle(createCommand('createPage'), signal)).toMatchObject({
      status: 'completed'
    })
    const files = Array.from({ length: 17 }, (_, index) => `docs/file-${index}.txt`)

    const result = await executor.handle(
      createCommand('createPage', {
        commandSequence: 2,
        commandId: 'upload-a',
        command: {
          type: 'automation',
          method: 'browser.upload',
          params: { element: '#upload', files }
        }
      }),
      signal
    )

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'browser_client_upload_file_count_exceeded'
    })
    expect(sendFileChannelRequest).not.toHaveBeenCalled()
    expect(executeAutomation).not.toHaveBeenCalled()
  } finally {
    await executor.close()
  }
})
