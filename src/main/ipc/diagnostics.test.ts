import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollectedBundle } from '../observability/bundle'
import type * as NodeFs from 'node:fs'

const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()

const {
  handleMock,
  mkdirSyncMock,
  readFileSyncMock,
  writeFileSyncMock,
  showMessageBoxMock,
  openPathMock,
  collectDiagnosticBundleMock,
  deleteDiagnosticBundleMock,
  getDiagnosticsStatusMock,
  uploadDiagnosticBundleMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  showMessageBoxMock: vi.fn(),
  openPathMock: vi.fn(),
  collectDiagnosticBundleMock: vi.fn(),
  deleteDiagnosticBundleMock: vi.fn(),
  getDiagnosticsStatusMock: vi.fn(),
  uploadDiagnosticBundleMock: vi.fn()
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    mkdirSync: mkdirSyncMock,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.2.3-test' },
  dialog: { showMessageBox: showMessageBoxMock },
  ipcMain: { handle: handleMock },
  shell: { openPath: openPathMock }
}))

vi.mock('../observability', () => ({
  collectDiagnosticBundle: collectDiagnosticBundleMock,
  deleteDiagnosticBundle: deleteDiagnosticBundleMock,
  getDiagnosticsStatus: getDiagnosticsStatusMock,
  uploadDiagnosticBundle: uploadDiagnosticBundleMock
}))

import { registerDiagnosticsHandlers } from './diagnostics'

function captureHandlers(): void {
  handlers.clear()
  for (const call of handleMock.mock.calls) {
    const [channel, handler] = call as [
      string,
      typeof handlers extends Map<string, infer V> ? V : never
    ]
    handlers.set(channel, handler)
  }
}

function makeBundle(overrides: Partial<CollectedBundle> = {}): CollectedBundle {
  return {
    bundleSubmissionId: 'abcdefghijklmnopqrstuv',
    payload: '{"type":"bundle-header"}\n',
    bytes: 25,
    spanCount: 0,
    ...overrides
  }
}

describe('diagnostics IPC handlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    mkdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
    writeFileSyncMock.mockReset()
    showMessageBoxMock.mockReset()
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    openPathMock.mockReset()
    openPathMock.mockResolvedValue('')
    collectDiagnosticBundleMock.mockReset()
    deleteDiagnosticBundleMock.mockReset()
    getDiagnosticsStatusMock.mockReset()
    uploadDiagnosticBundleMock.mockReset()
    delete (globalThis as { ORCA_BUILD_IDENTITY?: unknown }).ORCA_BUILD_IDENTITY
    delete (globalThis as { ORCA_DIAGNOSTICS_TOKEN_URL?: unknown }).ORCA_DIAGNOSTICS_TOKEN_URL
    process.env.ORCA_DIAGNOSTICS_TOKEN_URL = 'https://diagnostics.example.com/diagnostics/token'
    getDiagnosticsStatusMock.mockReturnValue({
      localFileEnabled: true,
      bundleEnabled: true,
      traceFilePath: '/tmp/main.trace.ndjson',
      traceFamilySize: 0
    })
    collectDiagnosticBundleMock.mockReturnValue(makeBundle())
    readFileSyncMock.mockReturnValue(makeBundle().payload)
    uploadDiagnosticBundleMock.mockResolvedValue({ ticketId: 'ticketabcdefghijklmnop' })
    deleteDiagnosticBundleMock.mockResolvedValue(undefined)
    registerDiagnosticsHandlers()
    captureHandlers()
  })

  it('rejects upload without a main-collected bundle preview', async () => {
    const upload = handlers.get('diagnostics:uploadBundle')!
    await expect(upload({}, 'rendererMintedBundleId')).rejects.toThrow(/expired/)
    expect(uploadDiagnosticBundleMock).not.toHaveBeenCalled()
  })

  it('rechecks the retained preview after upload confirmation', async () => {
    const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    const collect = handlers.get('diagnostics:collectBundle')!
    const openPreview = handlers.get('diagnostics:openBundlePreview')!
    const discard = handlers.get('diagnostics:discardBundlePreview')!
    const upload = handlers.get('diagnostics:uploadBundle')!
    showMessageBoxMock.mockImplementation(async () => {
      await discard({}, bundle.bundleSubmissionId)
      return { response: 0 }
    })

    await collect({}, 30)
    await openPreview({}, bundle.bundleSubmissionId)
    await expect(upload({}, bundle.bundleSubmissionId)).rejects.toThrow(/expired/)

    expect(uploadDiagnosticBundleMock).not.toHaveBeenCalled()
  })

  it('requires opening the retained review file before sending', async () => {
    const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    const collect = handlers.get('diagnostics:collectBundle')!
    const upload = handlers.get('diagnostics:uploadBundle')!

    await collect({}, 30)
    await expect(upload({}, bundle.bundleSubmissionId)).rejects.toThrow(/open.*review file/)
    expect(uploadDiagnosticBundleMock).not.toHaveBeenCalled()
  })

  it('expires retained bundle previews without another diagnostics call', async () => {
    vi.useFakeTimers()
    try {
      const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
      collectDiagnosticBundleMock.mockReturnValue(bundle)
      const collect = handlers.get('diagnostics:collectBundle')!
      const upload = handlers.get('diagnostics:uploadBundle')!

      await collect({}, 30)
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1)

      await expect(upload({}, bundle.bundleSubmissionId)).rejects.toThrow(/expired/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not expose retained bundle payloads through collection IPC', async () => {
    const bundle = makeBundle({
      bundleSubmissionId: 'bundleabcdefghijklmnop',
      payload: '{"secret":"retained in main"}\n'
    })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    const collect = handlers.get('diagnostics:collectBundle')!

    const preview = await collect({}, 30)
    expect(JSON.stringify(preview)).not.toContain('retained in main')
  })
})
