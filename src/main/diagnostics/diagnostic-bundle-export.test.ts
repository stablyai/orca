import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES } from '../../shared/diagnostic-bundle-export-types'
import type { DiagnosticBundleRuntimeStore } from './diagnostic-bundle-category-collector'

const {
  collectMemorySnapshotMock,
  collectDiagnosticBundleMock,
  getDiagnosticsStatusMock,
  listNativeCrashDumpsMock,
  showItemInFolderMock
} = vi.hoisted(() => ({
  collectMemorySnapshotMock: vi.fn(),
  collectDiagnosticBundleMock: vi.fn(),
  getDiagnosticsStatusMock: vi.fn(),
  listNativeCrashDumpsMock: vi.fn(),
  showItemInFolderMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3',
    getName: () => 'Orca',
    getLocale: () => 'en-US',
    getPath: (name: string) => join(tmpdir(), 'orca-test', name),
    isPackaged: false
  },
  shell: {
    showItemInFolder: showItemInFolderMock
  }
}))

vi.mock('../memory/collector', () => ({
  collectMemorySnapshot: collectMemorySnapshotMock
}))

vi.mock('../observability', () => ({
  collectDiagnosticBundle: collectDiagnosticBundleMock,
  getDiagnosticsStatus: getDiagnosticsStatusMock
}))

vi.mock('../observability/diagnostic-upload-endpoint', () => ({
  resolveDiagnosticOrcaChannel: () => 'dev'
}))

vi.mock('../crash-reporting/crash-report-store', () => ({
  CrashReportStore: {
    fromUserData: () => ({
      listRecent: vi.fn(async () => [{ id: 'crash-1', status: 'pending' }])
    })
  }
}))

vi.mock('./native-crash-dump-index', () => ({
  listNativeCrashDumps: listNativeCrashDumpsMock
}))

describe('exportDiagnosticBundle', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-diagnostic-bundle-'))
    collectMemorySnapshotMock.mockResolvedValue({
      app: {
        cpu: 0,
        memory: 0,
        main: { cpu: 0, memory: 0 },
        renderer: { cpu: 0, memory: 0 },
        other: { cpu: 0, memory: 0 },
        history: []
      },
      worktrees: [],
      host: {
        totalMemory: 0,
        freeMemory: 0,
        usedMemory: 0,
        memoryUsagePercent: 0,
        cpuCoreCount: 1,
        loadAverage1m: 0
      },
      totalCpu: 0,
      totalMemory: 0,
      collectedAt: 123
    })
    collectDiagnosticBundleMock.mockReturnValue({
      bundleSubmissionId: 'submission-1',
      payload: '{"type":"bundle-header"}\n',
      bytes: 25,
      spanCount: 0
    })
    getDiagnosticsStatusMock.mockReturnValue({
      localFileEnabled: true,
      bundleEnabled: true,
      traceFilePath: join(tempRoot, 'trace.ndjson'),
      traceFamilySize: 0
    })
    listNativeCrashDumpsMock.mockResolvedValue([])
    showItemInFolderMock.mockClear()
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
    await rm(join(tmpdir(), 'orca-test'), { recursive: true, force: true })
  })

  it('writes a ZIP with manifest and selected diagnostics files', async () => {
    const { exportDiagnosticBundle } = await import('./diagnostic-bundle-export')
    const output = 'bundle.zip'

    const result = await exportDiagnosticBundle({
      output,
      include: [
        'app',
        'system',
        'observability',
        'memory',
        'crash-reports',
        'runtime-counts',
        'terminal-lifecycle',
        'native-minidumps'
      ],
      store: makeStore()
    })

    const entries = readStoredZipEntries(await readFile(result.outputPath))
    expect([...entries.keys()].sort()).toEqual([
      'app/orca.json',
      'app/runtime-counts.json',
      'crash/orca-crash-reports.json',
      'crash/terminal-lifecycle.json',
      'diagnostics/observability.ndjson',
      'manifest.json',
      'memory/snapshot.json',
      'system/os.json',
      'system/resources.json'
    ])
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
      categories: { category: string; status: string; reason?: string; files: string[] }[]
      files: { path: string; bytes: number; sha256: string | null }[]
    }
    expect(manifest.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'app', status: 'included' }),
        expect.objectContaining({
          category: 'native-minidumps',
          status: 'skipped',
          reason: 'none_found'
        })
      ])
    )
    const manifestFile = manifest.files.find((file) => file.path === 'manifest.json')
    expect(manifestFile?.sha256).toBeNull()
    expect(manifestFile?.bytes).toBe(entries.get('manifest.json')!.byteLength)
    expect(result).toMatchObject({
      outputPath: join(tmpdir(), 'orca-test', 'logs', 'diagnostics', output),
      lookbackMinutes: 30,
      includedCategories: expect.arrayContaining(['app', 'system', 'memory']),
      skippedCategories: [expect.objectContaining({ category: 'native-minidumps' })],
      fileCount: manifest.files.length
    })
  })

  it('reveals the bundle when requested', async () => {
    const { exportDiagnosticBundle } = await import('./diagnostic-bundle-export')
    const output = 'bundle-open.zip'

    const result = await exportDiagnosticBundle({
      output,
      include: ['app'],
      open: true,
      store: makeStore()
    })

    expect(showItemInFolderMock).toHaveBeenCalledWith(result.outputPath)
  })

  it('caps direct caller lookback windows before running collectors', async () => {
    const { exportDiagnosticBundle } = await import('./diagnostic-bundle-export')
    const output = 'bundle-lookback-cap.zip'

    const result = await exportDiagnosticBundle({
      output,
      include: ['app'],
      lookbackMinutes: Number.MAX_SAFE_INTEGER,
      store: makeStore()
    })

    const entries = readStoredZipEntries(await readFile(result.outputPath))
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
      lookbackMinutes: number
    }
    expect(manifest.lookbackMinutes).toBe(MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES)
    expect(result.lookbackMinutes).toBe(MAX_DIAGNOSTIC_BUNDLE_LOOKBACK_MINUTES)
  })
})

function makeStore(): DiagnosticBundleRuntimeStore {
  return {
    getRepos: () => [{}],
    getRepo: () => undefined,
    getProjects: () => [],
    getProjectHostSetups: () => [],
    getFolderWorkspaces: () => [],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
  } as unknown as DiagnosticBundleRuntimeStore
}

function readStoredZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  let offset = 0
  while (offset < buffer.byteLength) {
    const signature = buffer.readUInt32LE(offset)
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break
    }
    expect(signature).toBe(0x04034b50)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const contentStart = nameStart + nameLength + extraLength
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8')
    entries.set(name, buffer.subarray(contentStart, contentStart + compressedSize))
    offset = contentStart + compressedSize
  }
  return entries
}
