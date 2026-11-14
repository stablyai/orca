import * as fs from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { wslGatedReadFile } from './wsl-transcript-fs-access'

vi.mock('node:fs/promises', { spy: true })

it('passes cancellation into the native whole-file operation, not just its caller wait', async () => {
  const controller = new AbortController()
  let operationSignal: AbortSignal | null | undefined
  const read = vi.mocked(fs.readFile).mockImplementationOnce(async (_path, options) => {
    operationSignal = typeof options === 'object' ? options?.signal : undefined
    return new Promise<string>((_resolve, reject) => {
      operationSignal?.addEventListener(
        'abort',
        () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        },
        { once: true }
      )
    })
  })
  try {
    const pending = wslGatedReadFile('/native/transcript.json', 'utf-8', 'scan', controller.signal)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(operationSignal).toBe(controller.signal)
    expect(operationSignal?.aborted).toBe(true)
  } finally {
    read.mockRestore()
  }
})
