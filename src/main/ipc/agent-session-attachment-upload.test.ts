import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'

type CallOptions = { expectedEnvironmentRuntimeId?: string; signal?: AbortSignal }
type Call = {
  method: string
  params: Record<string, unknown>
  revision?: number
  options?: CallOptions
}

const calls: Call[] = []
let serverStore: AgentSessionAttachmentStore
let failMethod: string | null = null

// The paired server, played by a real store: every call answers as the RPC handler would.
vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: async (
    _userDataPath: string,
    _environmentId: string,
    method: string,
    params: Record<string, unknown>,
    _timeoutMs?: number,
    revision?: number,
    _envelope?: unknown,
    options?: CallOptions
  ) => {
    calls.push({ method, params, revision, options })
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

const { uploadBufferToAgentSessionAttachments, uploadExternalPathsToAgentSessionAttachments } =
  await import('./agent-session-attachment-upload')

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
  calls.length = 0
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
    expect(await readFile(result.uploaded[0].path)).toEqual(big)
    expect(await readFile(result.uploaded[1].path, 'utf8')).toBe('# hi')
  })

  it('pins every call to the pairing and every call to the server process', async () => {
    await writeFile(join(workDir, 'a.txt'), 'a')
    await uploadExternalPathsToAgentSessionAttachments(context(), [join(workDir, 'a.txt')])
    expect(calls.map((call) => call.method)).toEqual([
      'agentSessionAttachment.uploadStart',
      'agentSessionAttachment.uploadAppend',
      'agentSessionAttachment.uploadCommit'
    ])
    for (const call of calls) {
      expect(call.revision).toBe(7)
      expect(call.options?.expectedEnvironmentRuntimeId).toBe('runtime-a')
    }
  })

  it('skips a folder as unsupported without walking into it', async () => {
    await mkdir(join(workDir, 'folder', 'nested'), { recursive: true })
    await writeFile(join(workDir, 'folder', 'inside.txt'), 'x')
    // A link inside would make the stager skip the folder as a symlink: never reached.
    await symlink(join(workDir, 'folder', 'inside.txt'), join(workDir, 'folder', 'nested', 'link'))
    const result = await uploadExternalPathsToAgentSessionAttachments(context(), [
      join(workDir, 'folder')
    ])
    expect(result.skipped).toEqual([{ sourcePath: join(workDir, 'folder'), reason: 'unsupported' }])
    expect(calls).toEqual([])
  })

  it('aborts a failed upload on the server and reports the file as failed', async () => {
    await writeFile(join(workDir, 'a.txt'), 'a')
    failMethod = 'agentSessionAttachment.uploadCommit'
    const result = await uploadExternalPathsToAgentSessionAttachments(context(), [
      join(workDir, 'a.txt')
    ])
    expect(result.uploaded).toEqual([])
    expect(result.failed).toEqual([
      { sourcePath: join(workDir, 'a.txt'), reason: 'agentSessionAttachment.uploadCommit failed' }
    ])
    expect(calls.at(-1)?.method).toBe('agentSessionAttachment.uploadAbort')
  })
})

describe('uploadBufferToAgentSessionAttachments', () => {
  it('stores a pasted image under the chat', async () => {
    const png = Buffer.alloc(900 * 1024, 3)
    const stored = await uploadBufferToAgentSessionAttachments(context(), 'orca-paste-1.png', png)
    expect(stored.name).toBe('orca-paste-1.png')
    expect(await readFile(stored.path)).toEqual(png)
    // 900 KiB in 384 KiB slices.
    expect(
      calls.filter((call) => call.method === 'agentSessionAttachment.uploadAppend')
    ).toHaveLength(3)
  })
})
