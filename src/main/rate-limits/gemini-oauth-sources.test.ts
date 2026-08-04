import { beforeEach, expect, it, vi } from 'vitest'

const { readSnapshotFileMock, writeCredentialMock } = vi.hoisted(() => ({
  readSnapshotFileMock: vi.fn(),
  writeCredentialMock: vi.fn()
}))

vi.mock('../filesystem-host/filesystem-host-read-authority', () => ({
  readSnapshotFileThroughFilesystemHost: readSnapshotFileMock
}))
vi.mock('../filesystem-host/filesystem-host-rate-limit-client', () => ({
  writeRateLimitCredentialThroughFilesystemHost: writeCredentialMock
}))

import { readAuthJsonSource, saveAuthJsonSource } from './gemini-oauth-sources'

beforeEach(() => {
  readSnapshotFileMock.mockReset()
  writeCredentialMock.mockReset()
})

it('treats non-object OpenCode auth JSON as an unavailable source', async () => {
  readSnapshotFileMock.mockResolvedValue(Buffer.from('null'))

  await expect(readAuthJsonSource()).resolves.toBeNull()
})

it('preserves unrelated OpenCode providers in the writable source', async () => {
  readSnapshotFileMock.mockResolvedValue(
    Buffer.from('{"google":{"type":"oauth","access":"a","expires":1,"refresh":"r"},"other":{}}')
  )

  await expect(readAuthJsonSource()).resolves.toMatchObject({
    value: { google: { type: 'oauth' }, other: {} }
  })
})

it('merges refreshed Google tokens into the latest OpenCode auth document', async () => {
  readSnapshotFileMock.mockResolvedValue(
    Buffer.from('{"google":{"type":"oauth","access":"old"},"added-during-refresh":{"key":"new"}}')
  )

  await saveAuthJsonSource({
    path: '/home/alice/.local/share/opencode/auth.json',
    value: {
      google: { type: 'oauth', access: 'refreshed', expires: 2, refresh: 'refresh' }
    }
  })

  expect(writeCredentialMock).toHaveBeenCalledWith(
    '/home/alice/.local/share/opencode/auth.json',
    'opencode-auth',
    expect.any(String)
  )
  const written = JSON.parse(writeCredentialMock.mock.calls[0][2])
  expect(written).toEqual({
    google: { type: 'oauth', access: 'refreshed', expires: 2, refresh: 'refresh' },
    'added-during-refresh': { key: 'new' }
  })
})
