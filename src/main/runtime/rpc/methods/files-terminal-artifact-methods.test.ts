import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { TERMINAL_ARTIFACT_DESKTOP_MAX_BYTES } from '../../../../shared/runtime-file-contracts'
import { FILE_METHODS } from './files'

const GRANT = { worktree: 'id:wt-1', grantId: 'grant-1', absolutePath: '/other/lock.json' }

function request(method: string, params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function runtimeReturning(content: string) {
  return {
    getRuntimeId: () => 'test-runtime',
    readTerminalArtifactFile: vi.fn().mockResolvedValue({
      worktree: 'wt-1',
      relativePath: GRANT.absolutePath,
      content,
      truncated: false,
      byteLength: content.length
    }),
    writeTerminalArtifactFile: vi.fn().mockResolvedValue({ ok: true })
  }
}

async function dispatchAs(
  runtime: ReturnType<typeof runtimeReturning>,
  clientKind: 'mobile' | 'runtime',
  method: string,
  params: unknown
): Promise<unknown> {
  const dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: FILE_METHODS
  })
  const reply = vi.fn()
  await dispatcher.dispatchStreaming(request(method, params), reply, { clientKind })
  const last = reply.mock.calls.at(-1)?.[0]
  return typeof last === 'string' ? JSON.parse(last) : last
}

describe('granted file budgets by client', () => {
  it('reads and saves a desktop client a granted file as large as a workspace one', async () => {
    const runtime = runtimeReturning('{}')

    await dispatchAs(runtime, 'runtime', 'files.readTerminalArtifact', GRANT)
    await dispatchAs(runtime, 'runtime', 'files.writeTerminalArtifact', { ...GRANT, content: '{}' })

    expect(runtime.readTerminalArtifactFile).toHaveBeenCalledWith(
      ...Object.values(GRANT),
      undefined,
      TERMINAL_ARTIFACT_DESKTOP_MAX_BYTES
    )
    expect(runtime.writeTerminalArtifactFile).toHaveBeenCalledWith(
      ...Object.values(GRANT),
      '{}',
      undefined,
      TERMINAL_ARTIFACT_DESKTOP_MAX_BYTES
    )
  })

  it('keeps a phone at its own budget', async () => {
    const runtime = runtimeReturning('{}')

    await dispatchAs(runtime, 'mobile', 'files.readTerminalArtifact', GRANT)
    await dispatchAs(runtime, 'mobile', 'files.writeTerminalArtifact', { ...GRANT, content: '{}' })

    expect(runtime.readTerminalArtifactFile).toHaveBeenCalledWith(
      ...Object.values(GRANT),
      undefined,
      undefined
    )
    expect(runtime.writeTerminalArtifactFile).toHaveBeenCalledWith(
      ...Object.values(GRANT),
      '{}',
      undefined,
      undefined
    )
  })

  it('keeps an in-process caller at the phone budget and answers the read', async () => {
    const runtime = runtimeReturning('{}')
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: FILE_METHODS
    })

    const response = await dispatcher.dispatch(request('files.readTerminalArtifact', GRANT))
    await dispatcher.dispatch(request('files.writeTerminalArtifact', { ...GRANT, content: '{}' }))

    expect(response).toMatchObject({ ok: true, result: { content: '{}' } })
    expect(runtime.readTerminalArtifactFile).toHaveBeenCalledWith(
      ...Object.values(GRANT),
      undefined,
      undefined
    )
    expect(runtime.writeTerminalArtifactFile).toHaveBeenCalledWith(
      ...Object.values(GRANT),
      '{}',
      undefined,
      undefined
    )
  })

  it('refuses text whose escaping outgrows one reply as too large', async () => {
    // Why: each control character escapes to six bytes, so 1 MB of them outgrows the 4 MB reply.
    const runtime = runtimeReturning('\u0001'.repeat(1024 * 1024))

    const response = await dispatchAs(runtime, 'runtime', 'files.readTerminalArtifact', GRANT)

    expect(response).toMatchObject({ ok: false, error: { message: 'file_too_large' } })
  })
})
