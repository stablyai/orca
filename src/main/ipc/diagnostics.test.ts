/* oxlint-disable max-lines -- Why: diagnostics IPC tests share mocked Electron handler setup; splitting would duplicate brittle IPC wiring. */
import { readFileSync, writeFileSync } from 'node:fs'
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
  showItemInFolderMock,
  collectDiagnosticBundleMock,
  deleteDiagnosticBundleMock,
  getDiagnosticsStatusMock,
  getTraceFilePathMock,
  uploadDiagnosticBundleMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  showMessageBoxMock: vi.fn(),
  openPathMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  collectDiagnosticBundleMock: vi.fn(),
  deleteDiagnosticBundleMock: vi.fn(),
  getDiagnosticsStatusMock: vi.fn(),
  getTraceFilePathMock: vi.fn(),
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
  shell: { openPath: openPathMock, showItemInFolder: showItemInFolderMock }
}))

vi.mock('../observability', () => ({
  clearLocalTraces: vi.fn(),
  collectDiagnosticBundle: collectDiagnosticBundleMock,
  deleteDiagnosticBundle: deleteDiagnosticBundleMock,
  getDiagnosticsStatus: getDiagnosticsStatusMock,
  getTraceFilePath: getTraceFilePathMock,
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
    showItemInFolderMock.mockReset()
    collectDiagnosticBundleMock.mockReset()
    deleteDiagnosticBundleMock.mockReset()
    getDiagnosticsStatusMock.mockReset()
    getTraceFilePathMock.mockReset()
    uploadDiagnosticBundleMock.mockReset()
    delete (globalThis as { ORCA_BUILD_IDENTITY?: unknown }).ORCA_BUILD_IDENTITY
    delete (globalThis as { ORCA_DIAGNOSTICS_TOKEN_URL?: unknown }).ORCA_DIAGNOSTICS_TOKEN_URL
    process.env.ORCA_DIAGNOSTICS_TOKEN_URL = 'https://diagnostics.example.com/diagnostics/token'
    getDiagnosticsStatusMock.mockReturnValue({
      localFileEnabled: true,
      otlpEnabled: false,
      bundleEnabled: true,
      otlpStatus: 'Disabled',
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

  it('uploads only the payload retained by main after collection', async () => {
    const bundle = makeBundle({
      bundleSubmissionId: 'bundleabcdefghijklmnop',
      payload: '{"type":"bundle-header"}\n{"safe":true}\n'
    })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    readFileSyncMock.mockReturnValue(bundle.payload)
    const collect = handlers.get('diagnostics:collectBundle')!
    const openPreview = handlers.get('diagnostics:openBundlePreview')!
    const upload = handlers.get('diagnostics:uploadBundle')!

    await collect({}, 30)
    await openPreview({}, bundle.bundleSubmissionId)
    await upload({}, bundle.bundleSubmissionId)

    expect(uploadDiagnosticBundleMock).toHaveBeenCalledWith({
      tokenEndpoint: 'https://diagnostics.example.com/diagnostics/token',
      payload: bundle.payload,
      bundleSubmissionId: bundle.bundleSubmissionId
    })
  })

  it('pins official builds to the compile-time diagnostics endpoint', async () => {
    const bundle = makeBundle({
      bundleSubmissionId: 'bundleabcdefghijklmnop',
      payload: '{"type":"bundle-header"}\n{"safe":true}\n'
    })
    const globalOverrides = globalThis as {
      ORCA_BUILD_IDENTITY?: 'stable'
      ORCA_DIAGNOSTICS_TOKEN_URL?: string
    }
    globalOverrides.ORCA_BUILD_IDENTITY = 'stable'
    globalOverrides.ORCA_DIAGNOSTICS_TOKEN_URL = 'https://official.example.com/diagnostics/token'
    process.env.ORCA_DIAGNOSTICS_TOKEN_URL = 'https://attacker.example.com/diagnostics/token'
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    readFileSyncMock.mockReturnValue(bundle.payload)
    const collect = handlers.get('diagnostics:collectBundle')!
    const openPreview = handlers.get('diagnostics:openBundlePreview')!
    const upload = handlers.get('diagnostics:uploadBundle')!

    await collect({}, 30)
    await openPreview({}, bundle.bundleSubmissionId)
    await upload({}, bundle.bundleSubmissionId)

    expect(uploadDiagnosticBundleMock).toHaveBeenCalledWith({
      tokenEndpoint: 'https://official.example.com/diagnostics/token',
      payload: bundle.payload,
      bundleSubmissionId: bundle.bundleSubmissionId
    })
  })

  it('requires main-owned user confirmation before upload', async () => {
    const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    const collect = handlers.get('diagnostics:collectBundle')!
    const openPreview = handlers.get('diagnostics:openBundlePreview')!
    const upload = handlers.get('diagnostics:uploadBundle')!

    await collect({}, 30)
    await openPreview({}, bundle.bundleSubmissionId)
    await expect(upload({}, bundle.bundleSubmissionId)).rejects.toThrow(/cancelled/)
    expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
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

  it('ignores edited preview file contents and uploads the retained original payload', async () => {
    const bundle = makeBundle({
      bundleSubmissionId: 'bundleabcdefghijklmnop',
      payload: '{"original":true}\n'
    })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    readFileSyncMock.mockReturnValue('{"edited":true}\n')
    const collect = handlers.get('diagnostics:collectBundle')!
    const openPreview = handlers.get('diagnostics:openBundlePreview')!
    const upload = handlers.get('diagnostics:uploadBundle')!

    await collect({}, 30)
    await openPreview({}, bundle.bundleSubmissionId)
    await upload({}, bundle.bundleSubmissionId)

    expect(readFileSync).not.toHaveBeenCalled()
    expect(uploadDiagnosticBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({ payload: '{"original":true}\n' })
    )
  })

  it('opens the retained bundle preview file through main', async () => {
    const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    const collect = handlers.get('diagnostics:collectBundle')!
    const openPreview = handlers.get('diagnostics:openBundlePreview')!

    await collect({}, 30)
    await openPreview({}, bundle.bundleSubmissionId)

    expect(openPathMock).toHaveBeenCalledWith(
      expect.stringContaining(`${bundle.bundleSubmissionId}.ndjson`)
    )
  })

  it('requires opening the retained preview before upload', async () => {
    const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    const collect = handlers.get('diagnostics:collectBundle')!
    const upload = handlers.get('diagnostics:uploadBundle')!

    await collect({}, 30)
    await expect(upload({}, bundle.bundleSubmissionId)).rejects.toThrow(/open.*preview/)
    expect(uploadDiagnosticBundleMock).not.toHaveBeenCalled()
  })

  it('discards retained bundle previews on request', async () => {
    const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    const collect = handlers.get('diagnostics:collectBundle')!
    const discard = handlers.get('diagnostics:discardBundlePreview')!
    const upload = handlers.get('diagnostics:uploadBundle')!

    await collect({}, 30)
    await discard({}, bundle.bundleSubmissionId)

    await expect(upload({}, bundle.bundleSubmissionId)).rejects.toThrow(/expired/)
  })

  it('clears retained previews when local traces are cleared', async () => {
    const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    const collect = handlers.get('diagnostics:collectBundle')!
    const clear = handlers.get('diagnostics:clearTraces')!
    const upload = handlers.get('diagnostics:uploadBundle')!

    await collect({}, 30)
    await clear({})

    await expect(upload({}, bundle.bundleSubmissionId)).rejects.toThrow(/expired/)
  })

  it('writes retained preview files with private permissions', async () => {
    const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    const collect = handlers.get('diagnostics:collectBundle')!

    await collect({}, 30)

    expect(mkdirSyncMock).toHaveBeenCalledWith(expect.any(String), {
      mode: 0o700,
      recursive: true
    })
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(`${bundle.bundleSubmissionId}.ndjson`),
      bundle.payload,
      { encoding: 'utf8', mode: 0o600 }
    )
  })

  it('returns only bundle metadata from collection', async () => {
    const bundle = makeBundle({
      bundleSubmissionId: 'bundleabcdefghijklmnop',
      payload: '{"type":"bundle-header"}\n{"safe":true}\n',
      bytes: 37,
      spanCount: 1
    })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    const collect = handlers.get('diagnostics:collectBundle')!

    expect(collect({}, 30)).toEqual({
      bundleSubmissionId: bundle.bundleSubmissionId,
      bytes: bundle.bytes,
      spanCount: bundle.spanCount
    })
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

  it('allows crash-report lookbacks beyond 24 hours while bounding abuse', async () => {
    const collect = handlers.get('diagnostics:collectBundle')!
    await collect({}, 3 * 24 * 60)
    expect(collectDiagnosticBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({ lookbackMinutes: 3 * 24 * 60 })
    )
  })

  it('registers and handles bundle deletion by ticket ID', async () => {
    const deleteBundle = handlers.get('diagnostics:deleteBundle')!
    await deleteBundle({}, 'ticketabcdefghijklmnop')
    expect(deleteDiagnosticBundleMock).toHaveBeenCalledWith({
      tokenEndpoint: 'https://diagnostics.example.com/diagnostics/token',
      ticketId: 'ticketabcdefghijklmnop'
    })
  })
})
