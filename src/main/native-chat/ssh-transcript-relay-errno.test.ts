import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'

const mocks = vi.hoisted(() => ({
  provider: undefined as IFilesystemProvider | undefined
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProviderSnapshot: () =>
    mocks.provider ? { provider: mocks.provider, generation: 1 } : null,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE: 'Remote connection dropped.'
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    getStatusSnapshot: () => [],
    getStatusSnapshotForPane: () => [
      {
        paneKey: 'relay-errno-pane',
        agentType: 'claude',
        connectionId: 'owner',
        providerSession: {
          key: 'session_id',
          id: 'remote-session',
          transcriptPath: '/home/user/session.jsonl'
        }
      }
    ],
    getTranscriptOwnerEvidence: () => [],
    hasUnresolvedRemoteTranscriptOwner: () => false,
    awaitTranscriptOwnerHydration: () => Promise.resolve()
  }
}))

import { readNativeChatTranscriptTail } from './transcript-tail-reader'

const transcriptPath = '/home/user/session.jsonl'

function missingProvider(error: Error): IFilesystemProvider {
  return {
    stat: vi.fn(async () => {
      throw error
    }),
    readFileRange: vi.fn(),
    supportsFileRangeRead: vi.fn(async () => true)
  } as unknown as IFilesystemProvider
}

function missingRangeProvider(error: Error): IFilesystemProvider {
  return {
    stat: vi.fn(async () => ({
      size: 1,
      type: 'file',
      mtime: 1,
      mtimeMs: 1,
      dev: 1,
      ino: 1
    })),
    readFileRange: vi.fn(async () => {
      throw error
    }),
    supportsFileRangeRead: vi.fn(async () => true)
  } as unknown as IFilesystemProvider
}

async function readTranscriptWithProvider(provider: IFilesystemProvider) {
  mocks.provider = provider
  return readNativeChatTranscriptTail({
    agent: 'claude',
    sessionId: 'remote-session',
    limit: 20,
    paneKey: 'relay-errno-pane'
  })
}

function readMissingTranscript(error: Error) {
  return readTranscriptWithProvider(missingProvider(error))
}

describe('SSH transcript relay errno classification', () => {
  beforeEach(() => {
    mocks.provider = undefined
  })

  it('classifies the relay structured errno as a retryable missing transcript', async () => {
    const error = Object.assign(new Error('remote path missing'), {
      code: -32000,
      data: { errno: 'ENOENT' }
    })

    await expect(readMissingTranscript(error)).resolves.toMatchObject({ notFound: true })
  })

  it('classifies structured ENOTDIR as a retryable missing transcript', async () => {
    const error = Object.assign(new Error('remote path component is not a directory'), {
      code: -32000,
      data: { errno: 'ENOTDIR' }
    })

    await expect(readMissingTranscript(error)).resolves.toMatchObject({ notFound: true })
  })

  it('keeps canonical-message compatibility with an older relay', async () => {
    const error = Object.assign(
      new Error(`ENOENT: no such file or directory, stat '${transcriptPath}'`),
      { code: -32000 }
    )

    await expect(readMissingTranscript(error)).resolves.toMatchObject({ notFound: true })
  })

  it('keeps canonical ENOTDIR compatibility with an older relay', async () => {
    const error = Object.assign(new Error(`ENOTDIR: not a directory, stat '${transcriptPath}'`), {
      code: -32000
    })

    await expect(readMissingTranscript(error)).resolves.toMatchObject({ notFound: true })
  })

  it('classifies a transcript removed after stat as retryable notFound', async () => {
    const error = Object.assign(new Error('remote path disappeared'), {
      code: -32000,
      data: { errno: 'ENOENT' }
    })

    await expect(readTranscriptWithProvider(missingRangeProvider(error))).resolves.toMatchObject({
      notFound: true
    })
  })

  it('prefers a structured non-absence errno over a legacy-looking message', async () => {
    const error = Object.assign(
      new Error(`ENOENT: no such file or directory, stat '${transcriptPath}'`),
      { code: -32000, data: { errno: 'EACCES' } }
    )

    await expect(readMissingTranscript(error)).resolves.toEqual({ error: error.message })
  })

  it('does not let malformed structured errno data enable message fallback', async () => {
    const error = Object.assign(
      new Error(`ENOENT: no such file or directory, stat '${transcriptPath}'`),
      { code: -32000, data: { errno: 2 } }
    )

    await expect(readMissingTranscript(error)).resolves.toEqual({ error: error.message })
  })
})
