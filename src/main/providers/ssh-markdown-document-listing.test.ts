import { describe, expect, it, vi } from 'vitest'
import { MarkdownDocumentListingCapacityError } from '../../shared/markdown-document-listing-limits'
import { JsonRpcErrorCode, RelayErrorCode } from '../ssh/relay-protocol'
import { requestSshMarkdownDocumentPaths } from './ssh-markdown-document-listing'

describe('SSH Markdown document listing', () => {
  it('requests producer-filtered Markdown paths', async () => {
    const request = vi.fn().mockResolvedValue(['README.md', 'docs/guide.mdx'])

    await expect(
      requestSshMarkdownDocumentPaths({ request } as never, '/home/user/project')
    ).resolves.toEqual(['README.md', 'docs/guide.mdx'])
    expect(request).toHaveBeenCalledWith('fs.listMarkdownDocuments', {
      rootPath: '/home/user/project'
    })
  })

  it('surfaces typed producer capacity failures', async () => {
    const request = vi.fn().mockRejectedValue(
      Object.assign(new Error('capacity'), {
        code: RelayErrorCode.MarkdownDocumentListingCapacity
      })
    )

    await expect(
      requestSshMarkdownDocumentPaths({ request } as never, '/home/user/project')
    ).rejects.toBeInstanceOf(MarkdownDocumentListingCapacityError)
  })

  it('requires reconnect instead of using an unbounded old-relay fallback', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('missing'), { code: JsonRpcErrorCode.MethodNotFound })
      )

    await expect(
      requestSshMarkdownDocumentPaths({ request } as never, '/home/user/project')
    ).rejects.toThrow('Reconnect the SSH target')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
