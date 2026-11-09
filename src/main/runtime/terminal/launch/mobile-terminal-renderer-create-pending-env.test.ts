import { expect, it, vi } from 'vitest'
import { REMOTE_VIEWER_CLIPBOARD_ENV } from '../../../../shared/remote-viewer-clipboard-env'

await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
const { store, TEST_WORKTREE_ID } =
  await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')

it('registers a paired create env before the renderer can spawn its pane (#39852)', async () => {
  const { electronMocks } = await import('../../orca-runtime-test-mocks/setup.spec')
  const runtime = new OrcaRuntimeService({ ...store })
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  const connection = new AbortController()
  let envAtCreateRequest: Record<string, string> | undefined
  electronMocks.BrowserWindow.fromId.mockReturnValue({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: vi.fn((channel: string, payload: { worktreeId?: string; tabId?: string }) => {
        if (channel !== 'terminal:requestTabCreate') {
          return
        }
        // Probe exactly what pty:spawn would read if it beat tabCreateReply.
        envAtCreateRequest = runtime.pendingRemoteViewerCreateEnv(
          payload.worktreeId!,
          payload.tabId!
        )
        connection.abort()
      }),
      setBackgroundThrottling: vi.fn(),
      capturePage: vi.fn(async () => null)
    }
  })

  await expect(
    runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      select: false,
      navigation: 'caller',
      clientNavigationId: 'paired-phone',
      terminalImageViewerSupported: true,
      signal: connection.signal
    })
  ).rejects.toThrow()
  expect(envAtCreateRequest).toMatchObject({ [REMOTE_VIEWER_CLIPBOARD_ENV]: '1' })
})
