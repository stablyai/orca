import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { downloadVerifiedArchive } from '../node-runtime/runtime-archive-download'
import { isRetryableDownloadError } from './transient-download-error'

it('retries fetch connection and body failures through their transport causes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-download-retry-'))
  try {
    const destination = join(root, 'archive')
    let attempt = 0
    await downloadVerifiedArchive(
      {
        label: 'fixture runtime',
        url: 'https://runtime.example/archive',
        archiveSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      },
      destination,
      async () => {
        if (attempt++ === 0) {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
          })
        }
        if (attempt === 2) {
          let started = false
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (!started) {
                  started = true
                  controller.enqueue(new Uint8Array([112, 97, 114, 116]))
                } else {
                  controller.error(
                    new TypeError('terminated', {
                      cause: Object.assign(new Error('other side closed'), {
                        code: 'UND_ERR_SOCKET'
                      })
                    })
                  )
                }
              }
            })
          )
        }
        return new Response('hello')
      },
      undefined,
      [0, 0]
    )
    expect(await readFile(destination, 'utf8')).toBe('hello')
    const cause = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    expect(
      isRetryableDownloadError(
        Object.assign(new Error('no retry', { cause }), {
          retryable: false
        })
      )
    ).toBe(false)
    expect(
      isRetryableDownloadError(
        Object.assign(new Error('missing release', { cause }), {
          httpStatusCode: 404
        })
      )
    ).toBe(false)
    expect(
      isRetryableDownloadError(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('expired certificate'), { code: 'CERT_HAS_EXPIRED' })
        })
      )
    ).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
