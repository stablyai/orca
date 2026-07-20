import { describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) }
}))

import { fetchRuntimeReleaseManifest } from './runtime-release-manifest'
import { RELEASE_MANIFEST_BASE_URL } from '../../shared/runtime-release-manifest'

function textResponse(ok: boolean, body: string): Response {
  return { ok, status: ok ? 200 : 404, text: () => Promise.resolve(body) } as unknown as Response
}

describe('fetchRuntimeReleaseManifest', () => {
  it('fetches the server-platform manifest and returns its yaml text', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(textResponse(true, 'version: 1.4.2\n'))

    const result = await fetchRuntimeReleaseManifest({ platform: 'linux', arch: 'arm64' })

    expect(result).toEqual({ ok: true, yaml: 'version: 1.4.2\n' })
    expect(fetchMock).toHaveBeenCalledWith(
      `${RELEASE_MANIFEST_BASE_URL}/latest-linux-arm64.yml`,
      expect.objectContaining({ signal: expect.anything() })
    )
  })

  it('returns ok:false for a platform with no published manifest without fetching', async () => {
    fetchMock.mockReset()
    expect(await fetchRuntimeReleaseManifest({ platform: 'freebsd' })).toEqual({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns ok:false on a 404 (release published before assets are reachable)', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(textResponse(false, 'Not Found'))
    expect(await fetchRuntimeReleaseManifest({ platform: 'win32' })).toEqual({ ok: false })
  })

  it('returns ok:false when the fetch rejects (timeout/DNS)', async () => {
    fetchMock.mockReset()
    fetchMock.mockRejectedValue(new Error('The operation was aborted'))
    expect(await fetchRuntimeReleaseManifest({ platform: 'darwin' })).toEqual({ ok: false })
  })

  it('returns ok:false when the response exceeds the byte cap', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(textResponse(true, 'x'.repeat(64 * 1024 + 1)))
    expect(await fetchRuntimeReleaseManifest({ platform: 'linux', arch: 'x64' })).toEqual({
      ok: false
    })
  })
})
