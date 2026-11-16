import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'

type CallOptions = { expectedEnvironmentRuntimeId?: string; signal?: AbortSignal }
let serverStore: AgentSessionAttachmentStore
let failMethod: string | null = null

// Use the real paired-server store behind the RPC seam.
vi.mock('./runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: async (
    _userDataPath: string,
    _environmentId: string,
    method: string,
    params: Record<string, unknown>,
    _timeoutMs?: number,
    _revision?: number,
    _envelope?: unknown,
    _options?: CallOptions
  ) => {
    if (method === failMethod) {
      return { ok: false, error: { code: 'internal', message: `${method} failed` } }
    }
    const callerKey = 'client-a'
    const uploadId = String(params.uploadId)
    try {
      const result =
        method === 'agentSessionAttachment.uploadStart'
          ? await serverStore.startUpload({
              callerKey,
              sessionId: String(params.sessionId),
              name: String(params.name),
              byteLength: Number(params.byteLength)
            })
          : method === 'agentSessionAttachment.uploadAppend'
            ? await serverStore.appendChunk({
                callerKey,
                uploadId,
                offset: Number(params.offset),
                contentBase64: String(params.contentBase64)
              })
            : method === 'agentSessionAttachment.uploadCommit'
              ? await serverStore.commitUpload({ callerKey, uploadId })
              : await serverStore.abortUpload({ callerKey, uploadId })
      return { ok: true, result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: 'internal', message } }
    }
  }
}))

const {
  uploadBufferToAgentSessionAttachments,
  uploadExternalPaths,
  uploadExternalPathsToAgentSessionAttachments
} = await import('./agent-session-attachment-upload')

let workDir: string
const context = () => ({
  environmentId: 'env-1',
  sessionId: 'session-1',
  expectedEnvironmentPairingRevision: 7,
  expectedEnvironmentRuntimeId: 'runtime-a',
  userDataPath: join(workDir, 'client-user-data')
})

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orca-attachment-upload-'))
  serverStore = new AgentSessionAttachmentStore(
    join(workDir, 'server', 'agent-session-attachments'),
    { hasSession: () => true }
  )
  failMethod = null
})

afterEach(async () => {
  serverStore.clearInFlightForTests()
  await rm(workDir, { recursive: true, force: true })
})

describe('uploadExternalPathsToAgentSessionAttachments', () => {
  it('uploads dropped files in order and returns only server paths', async () => {
    const big = Buffer.alloc(1024 * 1024, 7)
    await writeFile(join(workDir, 'big.bin'), big)
    await writeFile(join(workDir, 'notes.md'), '# hi')

    const result = await uploadExternalPathsToAgentSessionAttachments(context(), [
      join(workDir, 'big.bin'),
      join(workDir, 'notes.md')
    ])

    expect(result.skipped).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.uploaded.map(({ sourcePath }) => sourcePath)).toEqual([
      join(workDir, 'big.bin'),
      join(workDir, 'notes.md')
    ])
    for (const { path } of result.uploaded) {
      expect(path.startsWith(serverStore.rootDir)).toBe(true)
    }
    expect((await readFile(result.uploaded[0].path)).equals(big)).toBe(true)
    expect(await readFile(result.uploaded[1].path, 'utf8')).toBe('# hi')
  })
})

describe('uploadExternalPaths with a total for the drop', () => {
  it('refuses the files that would take one drop past its total and keeps sending the rest', async () => {
    await writeFile(join(workDir, 'a.txt'), '123456')
    await writeFile(join(workDir, 'b.txt'), '123456')
    await writeFile(join(workDir, 'c.txt'), '1234')
    const stored: string[] = []
    const result = await uploadExternalPaths(
      ['a.txt', 'b.txt', 'c.txt'].map((name) => join(workDir, name)),
      {
        maxBytes: 100,
        label: 'test limit',
        total: { maxBytes: 10, reason: (name) => `${name} is past the total` }
      },
      async (file, writeBody) => {
        await writeBody(async () => {})
        stored.push(file.name)
        return `/server/${file.name}`
      }
    )
    expect(stored).toEqual(['a.txt', 'c.txt'])
    expect(result.failed).toEqual([
      { sourcePath: join(workDir, 'b.txt'), reason: 'b.txt is past the total' }
    ])
  })
})

describe('uploadBufferToAgentSessionAttachments', () => {
  it('stores a pasted image under the chat', async () => {
    const png = Buffer.alloc(900 * 1024, 3)
    const stored = await uploadBufferToAgentSessionAttachments(context(), 'orca-paste-1.png', png)
    expect(stored.name).toBe('orca-paste-1.png')
    expect((await readFile(stored.path)).equals(png)).toBe(true)
  })
})
