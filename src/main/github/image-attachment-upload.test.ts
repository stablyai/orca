import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadGitHubImage } from './image-attachment-upload'

const { gh, acquire, release } = vi.hoisted(() => ({
  gh: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn()
}))
vi.mock('./gh-utils', () => ({
  ghExecFileAsync: gh,
  acquire,
  release,
  extractExecError: (error: unknown) => ({ stdout: '', stderr: String(error) })
}))
const repository = {
  ownerRepo: { owner: 'octo', repo: 'images', host: 'github.com' },
  ghOptions: { host: 'github.com' }
}
beforeEach(() => {
  vi.resetAllMocks()
})
describe('GitHub image attachment upload', () => {
  it('posts unchanged binary bytes with their exact content length in the resolved gh context', async () => {
    gh.mockResolvedValueOnce({ stdout: '{"id":123}' }).mockResolvedValueOnce({
      stdout: '{"url":"https://github.com/user-attachments/assets/a"}'
    })
    await expect(
      uploadGitHubImage({
        fileName: 'screen.png',
        contentType: 'image/png',
        bytes: Buffer.from([0, 128, 255]),
        resolve: async () => repository
      })
    ).resolves.toEqual({ url: 'https://github.com/user-attachments/assets/a' })
    expect(gh.mock.calls[0][0]).toEqual(['api', '--cache', '60s', 'repos/octo/images'])
    expect(gh.mock.calls[1][0]).toEqual([
      'api',
      '-X',
      'POST',
      'https://uploads.github.com/user-attachments/assets?name=screen.png&content_type=image%2Fpng&repository_id=123',
      '-H',
      'Content-Type: application/octet-stream',
      '-H',
      'Content-Length: 3',
      '--input',
      '-'
    ])
    expect(gh.mock.calls[1][1]).toMatchObject({
      host: 'github.com',
      idempotent: false,
      stdin: Buffer.from([0, 128, 255])
    })
  })
  it('reports a rejected upload without retrying the POST and releases admission', async () => {
    gh.mockResolvedValueOnce({ stdout: '{"id":123}' }).mockRejectedValueOnce(new Error('HTTP 403'))
    await expect(
      uploadGitHubImage({
        fileName: 'screen.png',
        contentType: 'image/png',
        bytes: Buffer.from([1]),
        resolve: async () => repository
      })
    ).rejects.toThrow('selected account')
    expect(gh.mock.calls.map((call) => call[0][0])).toEqual(['api', 'api'])
    expect(release).toHaveBeenCalledOnce()
  })
})
