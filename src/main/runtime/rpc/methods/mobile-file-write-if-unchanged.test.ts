import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { MOBILE_FILE_WRITE_METHODS } from './mobile-file-write-if-unchanged'

describe('mobile conflict-safe file write RPC', () => {
  it('allows only one concurrent save to consume a revision', async () => {
    let content = 'before'
    const runtime = fileRuntime(content)
    vi.mocked(runtime.readFileExplorerChunk).mockImplementation(async () => {
      const bytes = Buffer.from(content)
      return { contentBase64: bytes.toString('base64'), bytesRead: bytes.length, eof: true }
    })
    runtime.writeFileExplorerFile.mockImplementation(async (_worktree, _path, next) => {
      content = next
      return { ok: true }
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: MOBILE_FILE_WRITE_METHODS })
    const responses = await Promise.all(
      ['first', 'second'].map((next) =>
        dispatcher.dispatch(
          request({
            expectedRevision: revision('before'),
            contentBase64: Buffer.from(next).toString('base64'),
            expectedExecutionHostId: 'local'
          })
        )
      )
    )
    expect(responses).toMatchObject([
      { ok: true, result: { ok: true, revision: revision('first') } },
      { ok: true, result: { ok: false, code: 'conflict' } }
    ])
    expect(runtime.writeFileExplorerFile).toHaveBeenCalledOnce()
    expect(content).toBe('first')
  })

  it('rejects a queued save when an external writer changes the file mid-queue', async () => {
    let content = 'before'
    const runtime = fileRuntime(content)
    vi.mocked(runtime.readFileExplorerChunk).mockImplementation(async () => {
      const bytes = Buffer.from(content)
      return { contentBase64: bytes.toString('base64'), bytesRead: bytes.length, eof: true }
    })
    let releaseFirstWrite = (): void => {}
    const firstWriteStarted = new Promise<void>((resolveStarted) => {
      let held = false
      runtime.writeFileExplorerFile.mockImplementation(async (_worktree, _path, next) => {
        content = next
        if (held) {
          return { ok: true }
        }
        held = true
        resolveStarted()
        await new Promise<void>((release) => {
          releaseFirstWrite = release
        })
        return { ok: true }
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: MOBILE_FILE_WRITE_METHODS })
    const first = dispatcher.dispatch(
      request({
        expectedRevision: revision('before'),
        contentBase64: Buffer.from('first').toString('base64'),
        expectedExecutionHostId: 'local'
      })
    )
    await firstWriteStarted
    const second = dispatcher.dispatch(
      request({
        expectedRevision: revision('first'),
        contentBase64: Buffer.from('second').toString('base64'),
        expectedExecutionHostId: 'local'
      })
    )
    // The host queue only orders Orca's own writes, so an editor writing here must still be seen.
    content = 'external'
    releaseFirstWrite()

    expect(await first).toMatchObject({ ok: true, result: { ok: true } })
    expect(await second).toMatchObject({ ok: true, result: { ok: false, code: 'conflict' } })
    expect(runtime.writeFileExplorerFile).toHaveBeenCalledOnce()
    expect(content).toBe('external')
  })

  it('releases a failed write so the next request can retry the same revision', async () => {
    const runtime = fileRuntime('before')
    runtime.writeFileExplorerFile.mockRejectedValueOnce(new Error('write failed'))
    const dispatcher = new RpcDispatcher({ runtime, methods: MOBILE_FILE_WRITE_METHODS })
    const saving = () =>
      dispatcher.dispatch(
        request({
          expectedRevision: revision('before'),
          contentBase64: Buffer.from('after').toString('base64'),
          expectedExecutionHostId: 'local'
        })
      )
    const [failed, retried] = await Promise.all([saving(), saving()])
    expect(failed).toMatchObject({ ok: false })
    expect(retried).toMatchObject({ ok: true, result: { ok: true } })
    expect(runtime.writeFileExplorerFile).toHaveBeenCalledTimes(2)
  })

  it('preserves a UTF-8 BOM on disk and returns a revision usable by the next save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-mobile-file-write-'))
    const path = join(directory, 'notes.md')
    try {
      await writeFile(path, 'before')
      const runtime = fileRuntime('before')
      vi.mocked(runtime.readFileExplorerChunk).mockImplementation(async () => {
        const bytes = await readFile(path)
        return { contentBase64: bytes.toString('base64'), bytesRead: bytes.length, eof: true }
      })
      runtime.writeFileExplorerFile.mockImplementation(
        async (_worktree, _relativePath, content) => {
          await writeFile(path, content, 'utf8')
          return { ok: true }
        }
      )
      const dispatcher = new RpcDispatcher({ runtime, methods: MOBILE_FILE_WRITE_METHODS })
      const content = '\ufeff# Notes\r\nλ'
      const response = await dispatcher.dispatch(
        request({
          expectedRevision: revision('before'),
          contentBase64: Buffer.from(content).toString('base64'),
          expectedExecutionHostId: 'local'
        })
      )
      expect(await readFile(path)).toEqual(Buffer.from(content))
      expect(response).toMatchObject({
        ok: true,
        result: {
          ok: true,
          revision: revision(content),
          byteLength: Buffer.byteLength(content)
        }
      })
      const next = await dispatcher.dispatch(
        request({
          expectedRevision: revision(content),
          contentBase64: Buffer.from(`${content}\nnext`).toString('base64'),
          expectedExecutionHostId: 'local'
        })
      )
      expect(next).toMatchObject({ ok: true, result: { ok: true } })
      expect(await readFile(path, 'utf8')).toBe(`${content}\nnext`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes UTF-8 only after the current authorized content matches', async () => {
    const runtime = fileRuntime('before')
    const dispatcher = new RpcDispatcher({ runtime, methods: MOBILE_FILE_WRITE_METHODS })

    const response = await dispatcher.dispatch(
      request({
        expectedRevision: revision('before'),
        contentBase64: Buffer.from('after').toString('base64'),
        expectedExecutionHostId: 'ssh:target-1',
        expectedSshTargetId: 'target-1',
        expectedSshConnectionGeneration: 7
      })
    )

    expect(runtime.writeFileExplorerFile).toHaveBeenCalledWith(
      'id:repo-1::/workspace',
      'src/index.ts',
      'after',
      7,
      'target-1',
      'ssh:target-1'
    )
    expect(response).toMatchObject({
      ok: true,
      result: {
        ok: true,
        revision: revision('after'),
        byteLength: 5
      }
    })
  })

  it('returns a stable conflict without writing stale content', async () => {
    const runtime = fileRuntime('changed')
    const dispatcher = new RpcDispatcher({ runtime, methods: MOBILE_FILE_WRITE_METHODS })
    const response = await dispatcher.dispatch(
      request({
        expectedRevision: revision('before'),
        contentBase64: Buffer.from('after').toString('base64'),
        expectedExecutionHostId: 'local'
      })
    )

    expect(response).toMatchObject({ ok: true, result: { ok: false, code: 'conflict' } })
    expect(runtime.writeFileExplorerFile).not.toHaveBeenCalled()
  })

  it('refuses files that exceed the bounded editable snapshot', async () => {
    const runtime = fileRuntime('before', false)
    const dispatcher = new RpcDispatcher({ runtime, methods: MOBILE_FILE_WRITE_METHODS })
    const response = await dispatcher.dispatch(
      request({
        expectedRevision: revision('before'),
        contentBase64: '',
        expectedExecutionHostId: 'local'
      })
    )

    expect(response).toMatchObject({ ok: true, result: { ok: false, code: 'too_large' } })
    expect(runtime.writeFileExplorerFile).not.toHaveBeenCalled()
  })
})

function fileRuntime(content: string, eof = true) {
  const bytes = Buffer.from(content)
  return {
    getRuntimeId: () => 'test-runtime',
    readFileExplorerChunk: vi.fn().mockResolvedValue({
      contentBase64: bytes.toString('base64'),
      bytesRead: bytes.byteLength,
      eof
    }),
    writeFileExplorerFile: vi.fn().mockResolvedValue({ ok: true })
  } as unknown as OrcaRuntimeService & {
    writeFileExplorerFile: ReturnType<typeof vi.fn>
  }
}

function request(fields: {
  expectedRevision: string
  contentBase64: string
  expectedExecutionHostId: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}): RpcRequest {
  return {
    id: 'req-1',
    authToken: 'tok',
    method: 'files.writeIfUnchanged',
    params: {
      worktree: 'id:repo-1::/workspace',
      relativePath: 'src/index.ts',
      ...fields
    }
  }
}

function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
