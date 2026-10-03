import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILES_PDF_DESKTOP_OPEN_RUNTIME_CAPABILITY } from '../../../../shared/files-pdf-desktop-open-capability'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import { FILE_METHODS } from './files'
import { supportsFilesPdfDesktopOpen } from './files-open-pdf-desktop-capability'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'files.open', params }
}

function createDispatcher(): {
  runtime: { openMobileFile: ReturnType<typeof vi.fn> }
  dispatcher: RpcDispatcher
} {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    openMobileFile: vi.fn().mockResolvedValue({
      worktree: 'wt-1',
      relativePath: 'docs/example.pdf',
      kind: 'pdf',
      opened: true
    })
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler only reads openMobileFile.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: FILE_METHODS
  })
  return { runtime, dispatcher }
}

describe('files.open PDF desktop capability', () => {
  it('treats an in-process caller as this build', () => {
    expect(supportsFilesPdfDesktopOpen({})).toBe(true)
  })

  it('requires the capability from a negotiated client', () => {
    expect(supportsFilesPdfDesktopOpen({ clientKind: 'mobile', clientCapabilities: [] })).toBe(
      false
    )
    expect(
      supportsFilesPdfDesktopOpen({
        clientKind: 'runtime',
        clientCapabilities: [FILES_PDF_DESKTOP_OPEN_RUNTIME_CAPABILITY]
      })
    ).toBe(true)
  })

  it('is advertised by the CLI and mobile remote defaults', () => {
    expect(remoteRuntimeClientCapabilities()).toContain(FILES_PDF_DESKTOP_OPEN_RUNTIME_CAPABILITY)
  })

  it('opens a PDF for an in-process caller without a fourth argument', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', relativePath: 'docs/example.pdf' })
    )

    expect(runtime.openMobileFile).toHaveBeenCalledWith('id:wt-1', 'docs/example.pdf', undefined)
  })

  it('keeps the old binary answer for a client that would activate the file tab', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', relativePath: 'docs/example.pdf' }),
      { clientKind: 'mobile', clientCapabilities: [] }
    )

    expect(runtime.openMobileFile).toHaveBeenCalledWith(
      'id:wt-1',
      'docs/example.pdf',
      undefined,
      false
    )
  })

  it('opens a PDF for a client that advertises the desktop viewer', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', relativePath: 'docs/example.pdf' }),
      {
        clientKind: 'mobile',
        clientCapabilities: [FILES_PDF_DESKTOP_OPEN_RUNTIME_CAPABILITY]
      }
    )

    expect(runtime.openMobileFile).toHaveBeenCalledWith('id:wt-1', 'docs/example.pdf', undefined)
  })
})
