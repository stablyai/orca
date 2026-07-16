import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderNativePowerPointPreview } from './native-powerpoint-preview'

function createDependencies(platform: NodeJS.Platform = 'win32') {
  return {
    platform,
    createTemporaryDirectory: vi.fn(async () => 'C:\\temp\\orca-preview'),
    createDirectory: vi.fn(async (_path: string) => undefined),
    writeFile: vi.fn(async (_path: string, _content: string | Buffer) => undefined),
    readFile: vi.fn(async (_path: string) =>
      Buffer.concat([Buffer.from('PK'), Buffer.alloc(1_000)])
    ),
    removeDirectory: vi.fn(async (_path: string) => undefined),
    runPowerShell: vi.fn(async (_args: string[], _signal?: AbortSignal) => undefined),
    terminatePowerPointProcess: vi.fn(async (_path: string) => undefined)
  }
}

describe('renderNativePowerPointPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back without filesystem or process work on non-Windows hosts', async () => {
    const dependencies = createDependencies('linux')

    await expect(
      renderNativePowerPointPreview(
        { contentBase64: 'cHB0eA==', requestToken: 'preview-1' },
        dependencies
      )
    ).resolves.toEqual({
      status: 'unavailable',
      reason: 'Native PowerPoint rendering is only available on Windows.'
    })
    expect(dependencies.createTemporaryDirectory).not.toHaveBeenCalled()
    expect(dependencies.runPowerShell).not.toHaveBeenCalled()
  })

  it('returns the flattened PPTX and removes temporary files', async () => {
    const dependencies = createDependencies()
    const preview = Buffer.concat([Buffer.from('PK'), Buffer.alloc(1_000, 7)])
    dependencies.readFile.mockResolvedValue(preview)

    await expect(
      renderNativePowerPointPreview(
        { contentBase64: Buffer.from('source').toString('base64'), requestToken: 'preview-1' },
        dependencies
      )
    ).resolves.toEqual({ status: 'rendered', contentBase64: preview.toString('base64') })

    expect(dependencies.runPowerShell).toHaveBeenCalledOnce()
    expect(dependencies.runPowerShell.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['-InputPath', expect.stringMatching(/source\.pptx$/)])
    )
    expect(dependencies.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/source\.pptx$/),
      Buffer.from('source')
    )
    expect(dependencies.removeDirectory).toHaveBeenCalledWith('C:\\temp\\orca-preview')
  })

  it('falls back and cleans up when PowerPoint export fails', async () => {
    const dependencies = createDependencies()
    dependencies.runPowerShell.mockRejectedValue(new Error('PowerPoint is not installed'))

    await expect(
      renderNativePowerPointPreview(
        { contentBase64: 'cHB0eA==', requestToken: 'preview-1' },
        dependencies
      )
    ).resolves.toEqual({ status: 'unavailable', reason: 'PowerPoint is not installed' })
    expect(dependencies.terminatePowerPointProcess).toHaveBeenCalledWith(
      expect.stringMatching(/powerpoint\.pid$/)
    )
    expect(dependencies.removeDirectory).toHaveBeenCalledWith('C:\\temp\\orca-preview')
  })

  it('rejects an invalid PowerPoint output before returning it to the renderer', async () => {
    const dependencies = createDependencies()
    dependencies.readFile.mockResolvedValue(Buffer.alloc(1_001))

    await expect(
      renderNativePowerPointPreview(
        { contentBase64: 'cHB0eA==', requestToken: 'preview-1' },
        dependencies
      )
    ).resolves.toEqual({
      status: 'unavailable',
      reason: 'PowerPoint did not create a valid preview presentation.'
    })
  })

  it('passes cancellation to PowerShell and terminates the recorded PowerPoint process', async () => {
    const dependencies = createDependencies()
    const controller = new AbortController()
    dependencies.runPowerShell.mockImplementation(async (_args, signal) => {
      controller.abort()
      if (signal?.aborted) {
        throw new Error('The operation was aborted')
      }
    })

    await renderNativePowerPointPreview(
      { contentBase64: 'cHB0eA==', requestToken: 'preview-1' },
      dependencies,
      controller.signal
    )

    expect(dependencies.runPowerShell).toHaveBeenCalledWith(expect.any(Array), controller.signal)
    expect(dependencies.terminatePowerPointProcess).toHaveBeenCalledOnce()
  })
})
