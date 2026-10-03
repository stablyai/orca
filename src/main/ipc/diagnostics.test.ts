import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
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
  spawnProcessMock,
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
  spawnProcessMock: vi.fn(),
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

vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawnProcessMock }))

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
  let hostPlatform: PropertyDescriptor | undefined

  afterEach(() => {
    vi.useRealTimers()
    if (hostPlatform) {
      Object.defineProperty(process, 'platform', hostPlatform)
    }
  })

  beforeEach(() => {
    hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    spawnProcessMock.mockReset()
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

  it('returns a quiet cancellation when the user declines upload confirmation', async () => {
    const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    const collect = handlers.get('diagnostics:collectBundle')!
    const openPreview = handlers.get('diagnostics:openBundlePreview')!
    const upload = handlers.get('diagnostics:uploadBundle')!

    await collect({}, 30)
    await openPreview({}, bundle.bundleSubmissionId)
    await expect(upload({}, bundle.bundleSubmissionId)).resolves.toEqual({ canceled: true })
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

  it.each(['success', 'nonzero', 'missing', 'pending'] as const)(
    'keeps the Linux preview gate accurate for a %s launcher',
    async (outcome) => {
      vi.useFakeTimers()
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      spawnProcessMock.mockImplementationOnce(() => {
        const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
        queueMicrotask(() => {
          if (outcome === 'missing') {
            child.emit('error', new Error('spawn xdg-open ENOENT'))
          } else if (outcome !== 'pending') {
            child.emit('exit', outcome === 'success' ? 0 : 1, null)
          }
        })
        return child
      })
      const bundle = makeBundle({ bundleSubmissionId: 'linuxbundleabcdefghijklmnop' })
      collectDiagnosticBundleMock.mockReturnValue(bundle)
      await handlers.get('diagnostics:collectBundle')!({}, 30)
      const preview = handlers.get('diagnostics:openBundlePreview')!({}, bundle.bundleSubmissionId)
      const assertion =
        outcome === 'success'
          ? expect(preview).resolves.toBeUndefined()
          : expect(preview).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(1_500)
      await assertion
      expect(spawnProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [expect.stringContaining(`${bundle.bundleSubmissionId}.ndjson`)]
        })
      )
      expect(openPathMock).not.toHaveBeenCalled()
      if (outcome !== 'success') {
        await expect(
          handlers.get('diagnostics:uploadBundle')!({}, bundle.bundleSubmissionId)
        ).rejects.toThrow(/open.*review file/)
        expect(showMessageBoxMock).not.toHaveBeenCalled()
        expect(uploadDiagnosticBundleMock).not.toHaveBeenCalled()
      }
    }
  )

  it('requires opening the retained review file before sending', async () => {
    const bundle = makeBundle({ bundleSubmissionId: 'bundleabcdefghijklmnop' })
    collectDiagnosticBundleMock.mockReturnValue(bundle)
    const collect = handlers.get('diagnostics:collectBundle')!
    const upload = handlers.get('diagnostics:uploadBundle')!

    await collect({}, 30)
    await expect(upload({}, bundle.bundleSubmissionId)).rejects.toThrow(/open.*review file/)
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
