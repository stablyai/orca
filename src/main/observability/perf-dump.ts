import { app, dialog, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import {
  captureMainProfileArtifact,
  captureRendererProfileArtifact,
  PROFILE_CAPTURE_TIMEOUT_MS,
  type PerfArtifactStatus
} from './cpu-profile-capture'
import { collectRendererPerfMetrics } from './renderer-perf'
import { createTarGzipArchive, type TarArchiveEntry } from './tar-archive'
import { resolveDiagnosticOrcaChannel } from './diagnostic-upload-endpoint'
import { translateMain } from '../i18n/main-i18n'

export type PerfDumpProgressStage = 'metrics' | 'profile' | 'compressing'

export type CapturePerfDumpResult =
  | { readonly canceled: true }
  | { readonly filePath: string; readonly bytes: number }

type CapturePerfDumpOptions = {
  readonly getRendererWebContents: () => WebContents | null
  readonly onProgress?: (stage: PerfDumpProgressStage) => void
  /** Test seam: overrides the per-profile capture budget. */
  readonly profileCaptureTimeoutMs?: number
}

const MAX_TAR_ENTRY_BYTES = 0o77777777777
const ARTIFACT_ORDER = ['renderer-perf-metrics.json', 'renderer.cpuprofile', 'main.cpuprofile']

let inFlightCapture: Promise<CapturePerfDumpResult> | null = null
// Why: coalesced callers still need progress — a Settings remount mid-capture
// re-invokes with a fresh listener that must observe the running capture.
const activeProgressListeners = new Set<(stage: PerfDumpProgressStage) => void>()

function emitProgress(stage: PerfDumpProgressStage): void {
  for (const listener of activeProgressListeners) {
    try {
      listener(stage)
    } catch {
      /* a broken listener must not abort the capture */
    }
  }
}

export async function captureRendererPerfDump(
  opts: CapturePerfDumpOptions
): Promise<CapturePerfDumpResult> {
  if (opts.onProgress) {
    activeProgressListeners.add(opts.onProgress)
  }
  if (inFlightCapture) {
    return inFlightCapture
  }
  // Why: the consent dialog is part of the single-flight window — otherwise a
  // second trigger while the dialog is open would stack a second dialog.
  inFlightCapture = (async () => {
    const confirmed = await confirmPerfDumpCapture()
    if (!confirmed) {
      return { canceled: true } as const
    }
    return captureRendererPerfDumpInternal(opts)
  })().finally(() => {
    inFlightCapture = null
    activeProgressListeners.clear()
  })
  return inFlightCapture
}

async function confirmPerfDumpCapture(): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: [
      translateMain('auto.main.observability.perfDump.e6735719a0', 'Capture'),
      translateMain('auto.main.observability.perfDump.8d1d1d5725', 'Cancel')
    ],
    defaultId: 1,
    cancelId: 1,
    title: translateMain(
      'auto.main.observability.perfDump.3f8be4a51c',
      'Capture performance report?'
    ),
    message: translateMain(
      'auto.main.observability.perfDump.9c27d41e88',
      'This saves a local performance report for support.'
    ),
    detail: translateMain(
      'auto.main.observability.perfDump.b52ce7d316',
      'Orca will record about 10 seconds of CPU activity from its interface and background process, plus app metrics. The report contains timing data, Orca function names and source paths, and workspace folder names — not terminal text or file contents. It is saved to your computer only; nothing is uploaded.'
    )
  })
  return result.response === 0
}

async function captureRendererPerfDumpInternal({
  getRendererWebContents,
  profileCaptureTimeoutMs
}: CapturePerfDumpOptions): Promise<CapturePerfDumpResult> {
  const captureId = randomUUID()
  const tempRoot = join(app.getPath('temp'), 'orca-perf-dumps')
  const captureDir = join(tempRoot, captureId)
  const outputPath = await chooseOutputPath()
  const startedAt = new Date().toISOString()
  const artifacts: Record<string, PerfArtifactStatus> = {}
  const entries: TarArchiveEntry[] = []
  const captureTimeoutMs = profileCaptureTimeoutMs ?? PROFILE_CAPTURE_TIMEOUT_MS

  try {
    await mkdir(captureDir, { recursive: true, mode: 0o700 })
    emitProgress('metrics')
    await captureMetricsArtifact(captureDir, getRendererWebContents, artifacts, entries)

    emitProgress('profile')
    // Why: both profiles share one 10 s window so the report describes a
    // single incident rather than two disjoint time slices.
    await Promise.all([
      captureRendererProfileArtifact(
        captureDir,
        getRendererWebContents,
        artifacts,
        entries,
        captureTimeoutMs
      ),
      captureMainProfileArtifact(captureDir, artifacts, entries, captureTimeoutMs)
    ])

    emitProgress('compressing')
    // Why: the concurrent profile captures finish in either order; pin the
    // archive layout so reports are deterministic.
    entries.sort((a, b) => ARTIFACT_ORDER.indexOf(a.name) - ARTIFACT_ORDER.indexOf(b.name))
    // Why: filter before writing metadata so oversized-artifact skip notes
    // land inside the archived metadata.json.
    const packableEntries = await filterPackableEntries(entries, artifacts)

    const metadataPath = join(captureDir, 'metadata.json')
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          schema_version: 2,
          capture_id: captureId,
          app_version: app.getVersion(),
          platform: platform(),
          arch: arch(),
          os_release: release(),
          orca_channel: resolveDiagnosticOrcaChannel(),
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          artifacts
        },
        null,
        2
      )}\n`,
      { encoding: 'utf8', mode: 0o600 }
    )
    packableEntries.unshift({ name: 'metadata.json', filePath: metadataPath })

    await createTarGzipArchive(outputPath, packableEntries)
    const outputInfo = await stat(outputPath)
    return { filePath: outputPath, bytes: outputInfo.size }
  } catch (error) {
    try {
      await rm(outputPath, { force: true })
    } catch {
      // Why: cleanup failure must not mask the original capture error.
    }
    throw error
  } finally {
    await rm(captureDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function captureMetricsArtifact(
  captureDir: string,
  getRendererWebContents: () => WebContents | null,
  artifacts: Record<string, PerfArtifactStatus>,
  entries: TarArchiveEntry[]
): Promise<void> {
  const fileName = 'renderer-perf-metrics.json'
  const filePath = join(captureDir, fileName)
  try {
    // Why: the dump stays local behind explicit consent, so it may keep the
    // folder-basename labels that the uploadable bundle anonymizes.
    const metrics = await collectRendererPerfMetrics(getRendererWebContents, {
      labelMode: 'named'
    })
    await writeFile(filePath, `${JSON.stringify(metrics, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    const info = await stat(filePath)
    artifacts.metrics = { status: 'included', fileName, bytes: info.size }
    entries.push({ name: fileName, filePath })
  } catch (error) {
    artifacts.metrics = {
      status: 'failed',
      reason: error instanceof Error && error.message ? error.message.slice(0, 200) : 'unavailable'
    }
  }
}

async function filterPackableEntries(
  entries: readonly TarArchiveEntry[],
  artifacts: Record<string, PerfArtifactStatus>
): Promise<TarArchiveEntry[]> {
  const kept: TarArchiveEntry[] = []
  for (const entry of entries) {
    const info = await stat(entry.filePath)
    if (info.size > MAX_TAR_ENTRY_BYTES) {
      artifacts[`skipped:${entry.name}`] = {
        status: 'omitted',
        fileName: entry.name,
        reason: 'file exceeds tar size limit'
      }
      continue
    }
    kept.push(entry)
  }
  return kept
}

async function chooseOutputPath(): Promise<string> {
  const downloads = app.getPath('downloads')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`
    const candidate = join(downloads, `orca-performance-report-${stamp}${suffix}.tar.gz`)
    try {
      await stat(candidate)
    } catch (error) {
      // Why: only ENOENT proves the name is free — any other stat failure
      // could hide an existing file the archive writer would truncate.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return candidate
      }
    }
  }
  throw new Error('Could not choose a unique file name in Downloads.')
}
