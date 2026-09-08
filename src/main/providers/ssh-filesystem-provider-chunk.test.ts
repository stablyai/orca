import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { SshFilesystemProvider } from './ssh-filesystem-provider'

describe('SshFilesystemProvider file chunks', () => {
  let request: ReturnType<typeof vi.fn>
  let provider: SshFilesystemProvider

  beforeEach(() => {
    request = vi.fn()
    provider = new SshFilesystemProvider('connection-1', {
      request,
      onNotification: vi.fn(),
      onNotificationByMethod: vi.fn(() => () => {}),
      onDispose: vi.fn(() => () => {}),
      isDisposed: vi.fn(() => false)
    } as never)
  })

  it('requests an exact remote range without downloading the full file', async () => {
    request.mockResolvedValue({ contentBase64: 'AQI=', bytesRead: 2, eof: false })

    await expect(provider.readFileChunk('C:\\repo\\data.bin', 4, 2)).resolves.toEqual({
      contentBase64: 'AQI=',
      bytesRead: 2,
      eof: false
    })
    expect(request).toHaveBeenCalledWith('fs.readFileChunk', {
      filePath: 'C:\\repo\\data.bin',
      offset: 4,
      length: 2
    })
  })

  it('degrades explicitly when the remote host predates range reads', async () => {
    const error = new Error('Method not found') as Error & { code: number }
    error.code = JsonRpcErrorCode.MethodNotFound
    request.mockRejectedValue(error)

    await expect(provider.readFileChunk('/repo/data.bin', 0, 2)).rejects.toThrow(
      'updated Orca host'
    )
  })

  it('forwards terminal grant identity with exact remote artifact ranges', async () => {
    request.mockResolvedValue({ contentBase64: 'AQI=', bytesRead: 2, eof: true })

    await expect(
      provider.readTerminalArtifactChunk('/tmp/result.bin', 4, 2, {
        expectedRealPath: '/tmp/result.bin',
        expectedStatIdentity: '1:2:1:6:3',
        maxBytes: 1024
      })
    ).resolves.toEqual({ contentBase64: 'AQI=', bytesRead: 2, eof: true })
    expect(request).toHaveBeenCalledWith('fs.readTerminalArtifactChunk', {
      filePath: '/tmp/result.bin',
      offset: 4,
      length: 2,
      expectedRealPath: '/tmp/result.bin',
      expectedStatIdentity: '1:2:1:6:3',
      maxBytes: 1024
    })
  })
})
