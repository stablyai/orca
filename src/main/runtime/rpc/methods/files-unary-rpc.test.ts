import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { remoteRpcContentBudget } from '../../../../shared/remote-rpc-content-budget'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { FILE_METHODS } from './files'
import { FILE_MUTATION_METHODS } from './files-mutation-methods'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('files.readDocPreview', () => {
  it('passes document-preview authority to the dedicated host method', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The explicit file registry only reads the members stubbed for this case.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readDocPreviewFile: vi.fn().mockResolvedValue({
        content: '<h1>safe</h1>',
        isBinary: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'files.readDocPreview',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'docs/index.html',
        entryRelativePath: 'docs/index.html',
        implicitRootRelativePath: 'docs',
        authorizedRootRelativePaths: ['assets']
      }
    }

    const response = await dispatcher.dispatch(request)

    expect(runtime.readDocPreviewFile).toHaveBeenCalledWith(
      'id:wt-1',
      'docs/index.html',
      'docs/index.html',
      'docs',
      ['assets'],
      undefined
    )
    expect(response).toMatchObject({ ok: true, result: { content: '<h1>safe</h1>' } })
  })
})

describe.each([
  ['files.writeBase64', 'writeFileExplorerFileBase64'],
  ['files.writeBase64Chunk', 'writeFileExplorerFileBase64Chunk']
] as const)('%s base64 padding', (method, runtimeMethod) => {
  it.each([
    ['A=', false],
    ['AA=', false],
    ['A==', false],
    ['==', false],
    ['AAAAA=', false],
    ['AAAAAA=', false],
    ['AAAAA==', false],
    ['AAAA==', false],
    ['AA==', true],
    ['AAA=', true],
    ['AAAA', true],
    ['', true],
    ['A', false],
    ['AA=A', false],
    ['AA', true],
    ['AAA', true]
  ])('validates %j before writing (accepted: %s)', async (contentBase64, accepted) => {
    const write = vi.fn().mockResolvedValue({ ok: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The explicit file registry only reads the members stubbed for this case.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      [runtimeMethod]: write
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_MUTATION_METHODS })

    const response = await dispatcher.dispatch({
      id: 'padding',
      authToken: 'tok',
      method,
      params: {
        worktree: 'id:wt-1',
        relativePath: 'upload.bin',
        contentBase64,
        append: true
      }
    })

    expect(response).toMatchObject({ ok: accepted })
    expect(write).toHaveBeenCalledTimes(accepted ? 1 : 0)
    if (accepted) {
      expect(write).toHaveBeenCalledWith(
        'id:wt-1',
        'upload.bin',
        contentBase64,
        ...(method === 'files.writeBase64Chunk' ? [true] : [])
      )
    }
  })
})

describe('file preview RPC transport budgets', () => {
  it.each(['mobile', 'runtime'] as const)(
    'charges the %s request id to both preview content budgets',
    async (clientKind) => {
      const preview = {
        content: 'base64',
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      }
      const readFileExplorerPreview = vi.fn().mockResolvedValue(preview)
      const readTerminalArtifactPreview = vi.fn().mockResolvedValue(preview)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The explicit file registry only reads the members stubbed for this case.
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        readFileExplorerPreview,
        readTerminalArtifactPreview
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
      const id = '\u0001'.repeat(8_192)
      const reply = vi.fn()

      await dispatcher.dispatchStreaming(
        {
          ...makeRequest('files.readPreview', { worktree: 'id:wt-1', relativePath: 'logo.png' }),
          id
        },
        reply,
        { clientKind }
      )
      await dispatcher.dispatchStreaming(
        {
          ...makeRequest('files.readTerminalArtifactPreview', {
            worktree: 'id:wt-1',
            absolutePath: '/tmp/logo.png',
            grantId: 'grant-1'
          }),
          id
        },
        reply,
        { clientKind }
      )

      const budget = remoteRpcContentBudget(id)
      expect(readFileExplorerPreview).toHaveBeenCalledWith('id:wt-1', 'logo.png', budget)
      expect(readTerminalArtifactPreview).toHaveBeenCalledWith(
        'id:wt-1',
        'grant-1',
        '/tmp/logo.png',
        undefined,
        budget
      )
    }
  )
})

describe('files.listAll page size', () => {
  // Older hosts omit the optional client-named cap.
  it('forwards a client-named page size for a selected worktree', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The explicit file registry only reads the members stubbed for this case.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listRuntimeFiles: vi.fn().mockResolvedValue(['src/index.ts'])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.listAll', { worktree: 'id:wt-1', maxResults: 20_001 })
    )

    expect(runtime.listRuntimeFiles).toHaveBeenCalledWith('id:wt-1', {
      excludePaths: undefined,
      maxResults: 20_001
    })
    expect(response).toMatchObject({ ok: true, result: ['src/index.ts'] })
  })

  // A malformed cap indicates a caller bug.
  it('refuses a malformed page size instead of silently picking one', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The explicit file registry only reads the members stubbed for this case.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listRuntimeFiles: vi.fn().mockResolvedValue(['src/index.ts'])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.listAll', { worktree: 'id:wt-1', maxResults: -3 })
    )

    expect(response).toMatchObject({ ok: false })
  })
})

describe('files.resolveTerminalPath RPC', () => {
  function createDispatcher() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The explicit file registry only reads the members stubbed for this case.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveTerminalPath: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        relativePath: 'src/index.ts',
        exists: true,
        isDirectory: false
      })
    } as unknown as OrcaRuntimeService
    return { runtime, dispatcher: new RpcDispatcher({ runtime, methods: FILE_METHODS }) }
  }

  it('resolves a tapped terminal path for a selected worktree', async () => {
    const { runtime, dispatcher } = createDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('files.resolveTerminalPath', {
        worktree: 'id:wt-1',
        pathText: '/repo/src/index.ts',
        cwd: '/repo',
        terminal: 'term-1'
      })
    )

    expect(runtime.resolveTerminalPath).toHaveBeenCalledWith(
      'id:wt-1',
      '/repo/src/index.ts',
      '/repo',
      undefined,
      'term-1',
      false,
      null
    )
    expect(response).toMatchObject({
      ok: true,
      result: { relativePath: 'src/index.ts', exists: true, isDirectory: false }
    })
  })

  // Why: clients predating crossWorkspace reuse their own worktree id for the
  // follow-up files.open, so sibling-workspace retargeting must be an explicit opt-in.
  it('forwards crossWorkspace only when the client opts in', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest('files.resolveTerminalPath', {
        worktree: 'id:wt-1',
        pathText: '/sibling/docs/readme.md',
        crossWorkspace: true
      })
    )

    expect(runtime.resolveTerminalPath).toHaveBeenLastCalledWith(
      'id:wt-1',
      '/sibling/docs/readme.md',
      null,
      undefined,
      null,
      true,
      null
    )
  })

  it('forwards optional native-chat provenance', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest('files.resolveTerminalPath', {
        worktree: 'id:wt-1',
        pathText: '/outside/result.html',
        nativeChatContext: { tabId: 'tab-1', sessionId: 'session-1' }
      })
    )

    expect(runtime.resolveTerminalPath).toHaveBeenLastCalledWith(
      'id:wt-1',
      '/outside/result.html',
      null,
      undefined,
      null,
      false,
      { tabId: 'tab-1', sessionId: 'session-1' }
    )
  })
})

describe('file open RPC navigation', () => {
  function createDispatcher(): {
    runtime: Pick<OrcaRuntimeService, 'openMobileFile' | 'openMobileDiff'>
    dispatcher: RpcDispatcher
  } {
    const opened = { worktree: 'wt-1', relativePath: 'a.ts', kind: 'text', opened: true }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      openMobileFile: vi.fn().mockResolvedValue(opened),
      openMobileDiff: vi.fn().mockResolvedValue(opened)
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FILE_METHODS open handlers only read the stubbed members.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: FILE_METHODS
    })
    return { runtime, dispatcher }
  }

  it('passes an explicit navigation target through file and diff opens', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.ts', navigation: 'all' })
    )
    await dispatcher.dispatch(
      makeRequest('files.openDiff', {
        worktree: 'id:wt-1',
        relativePath: 'a.ts',
        navigation: 'host'
      })
    )

    expect(runtime.openMobileFile).toHaveBeenCalledWith('id:wt-1', 'a.ts', 'all')
    expect(runtime.openMobileDiff).toHaveBeenCalledWith('id:wt-1', 'a.ts', false, 'host')
  })

  it('leaves navigation absent for callers that send none (phones, older CLIs)', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.ts' })
    )
    await dispatcher.dispatch(
      makeRequest('files.openDiff', { worktree: 'id:wt-1', relativePath: 'a.ts', staged: true })
    )

    expect(runtime.openMobileFile).toHaveBeenCalledWith('id:wt-1', 'a.ts', undefined)
    expect(runtime.openMobileDiff).toHaveBeenCalledWith('id:wt-1', 'a.ts', true, undefined)
  })

  it('forwards optional positions, leaving diffs unchanged', async () => {
    const { runtime, dispatcher } = createDispatcher()
    const response = await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.ts', line: 42, column: 7 })
    )
    expect(response).toMatchObject({ ok: true })
    expect(runtime.openMobileFile).toHaveBeenCalledWith('id:wt-1', 'a.ts', undefined, {
      line: 42,
      column: 7
    })
    await dispatcher.dispatch(
      makeRequest('files.openDiff', { worktree: 'id:wt-1', relativePath: 'a.ts', line: 42 })
    )
    expect(runtime.openMobileDiff).toHaveBeenCalledWith('id:wt-1', 'a.ts', false, undefined)
  })

  it('rejects a column without a line', async () => {
    const { runtime, dispatcher } = createDispatcher()
    const response = await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.ts', column: 7 })
    )
    expect(response).toMatchObject({ ok: false })
    expect(runtime.openMobileFile).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, '12', Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid RPC positions %j',
    async (line) => {
      const { runtime, dispatcher } = createDispatcher()
      const response = await dispatcher.dispatch(
        makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'a.ts', line })
      )
      expect(response).toMatchObject({ ok: false })
      expect(runtime.openMobileFile).not.toHaveBeenCalled()
    }
  )

  it('rejects an unknown navigation target on file opens', async () => {
    const { runtime, dispatcher } = createDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('files.open', {
        worktree: 'id:wt-1',
        relativePath: 'a.ts',
        navigation: 'everyone'
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(runtime.openMobileFile).not.toHaveBeenCalled()
  })
})
