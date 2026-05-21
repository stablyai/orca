// IPC surface for the error-tracking lane (telemetry-error-tracking.md
// §User controls). Seven renderer-facing channels:
//
//   diagnostics:getStatus            — read-only snapshot for the Privacy pane.
//   diagnostics:openTraceFolder      — Reveal in Finder / Explorer.
//   diagnostics:clearTraces          — delete the rotated NDJSON family.
//   diagnostics:collectBundle        — assemble and retain a redacted payload.
//   diagnostics:openBundlePreview    — open the retained payload in the OS.
//   diagnostics:discardBundlePreview — delete a retained, unuploaded payload.
//   diagnostics:uploadBundle         — POST the main-retained payload.
//   diagnostics:deleteBundle         — delete an uploaded bundle by ticket ID.
//
// Same threat model as the product-telemetry IPC (`ipc/telemetry.ts`):
// renderer can pass anything over the wire, type-narrow here. Everything
// that touches the network or filesystem stays in main — the renderer
// only sees the resulting status / preview / ticket-id.
//
// Hardening item §Endpoint contract #10 ("No renderer access to any of
// these endpoints"): the upload endpoint URL never crosses IPC. The
// renderer triggers the flow; main reads the URL from a build-time
// constant or env var and does the POST itself.

import { app, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearLocalTraces,
  collectDiagnosticBundle,
  deleteDiagnosticBundle,
  getDiagnosticsStatus,
  getTraceFilePath,
  uploadDiagnosticBundle,
  type DiagnosticsStatus
} from '../observability'
import type { CollectedBundle } from '../observability/bundle'
import type { UploadBundleResult } from '../observability/diagnostic-bundle-upload'

export type DiagnosticsBundlePreview = Omit<CollectedBundle, 'payload'>

const PENDING_BUNDLE_TTL_MS = 15 * 60 * 1000
const MAX_PENDING_BUNDLES = 8

type PendingBundle = {
  bundle: CollectedBundle
  readonly createdAtMs: number
  readonly previewFilePath: string
  previewOpened: boolean
}

const pendingBundles = new Map<string, PendingBundle>()

// Build-time constant for the diagnostic-token endpoint. Substituted by
// electron-vite at compile time. Local / contributor builds get `null`,
// at which point the upload path returns a clear "endpoint not configured"
// error rather than POSTing to a placeholder.
//
// The dev escape hatch is `ORCA_DIAGNOSTICS_TOKEN_URL` — set this env var
// to point at a local server during development. Mirrors the
// `ORCA_OTLP_TRACES_URL` env-var pattern for OTLP.
function resolveBuildTokenEndpoint(): string | null {
  const endpoint =
    typeof ORCA_DIAGNOSTICS_TOKEN_URL !== 'undefined'
      ? ORCA_DIAGNOSTICS_TOKEN_URL
      : ((globalThis as { ORCA_DIAGNOSTICS_TOKEN_URL?: string | null })
          .ORCA_DIAGNOSTICS_TOKEN_URL ?? null)
  return typeof endpoint === 'string' && endpoint.length > 0 ? endpoint : null
}

function resolveBuildIdentity(): 'stable' | 'rc' | null {
  const ident =
    typeof ORCA_BUILD_IDENTITY !== 'undefined'
      ? ORCA_BUILD_IDENTITY
      : ((globalThis as { ORCA_BUILD_IDENTITY?: 'stable' | 'rc' | null }).ORCA_BUILD_IDENTITY ??
        null)
  return ident === 'stable' || ident === 'rc' ? ident : null
}

function resolveTokenEndpoint(): string | null {
  const buildEndpoint = resolveBuildTokenEndpoint()
  // Official builds must stay pinned to the CI-substituted endpoint; the
  // upload confirmation says "Orca support", so env cannot redirect it.
  if (resolveBuildIdentity()) {
    return buildEndpoint
  }
  // Env wins only for dev / unofficial builds so contributors can point a
  // local packaged app at staging without re-running a release pipeline.
  const fromEnv = process.env.ORCA_DIAGNOSTICS_TOKEN_URL
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv
  }
  return buildEndpoint
}

function resolveOrcaChannel(): 'stable' | 'rc' | 'dev' {
  const ident = resolveBuildIdentity()
  if (ident === 'stable' || ident === 'rc') {
    return ident
  }
  return 'dev'
}

function prunePendingBundles(now = Date.now()): void {
  for (const [id, pending] of pendingBundles) {
    if (now - pending.createdAtMs > PENDING_BUNDLE_TTL_MS) {
      deletePreviewFile(pending.previewFilePath)
      pendingBundles.delete(id)
    }
  }
  while (pendingBundles.size > MAX_PENDING_BUNDLES) {
    const oldest = pendingBundles.keys().next().value as string | undefined
    if (!oldest) {
      break
    }
    const pending = pendingBundles.get(oldest)
    if (pending) {
      deletePreviewFile(pending.previewFilePath)
      pendingBundles.delete(oldest)
    }
  }
}

function rememberBundle(bundle: CollectedBundle): void {
  const previewFilePath = writeBundlePreviewFile(bundle)
  pendingBundles.set(bundle.bundleSubmissionId, {
    bundle,
    createdAtMs: Date.now(),
    previewFilePath,
    previewOpened: false
  })
  prunePendingBundles()
}

function toBundlePreview(bundle: CollectedBundle): DiagnosticsBundlePreview {
  return {
    bundleSubmissionId: bundle.bundleSubmissionId,
    bytes: bundle.bytes,
    spanCount: bundle.spanCount
  }
}

function getPendingBundleForUpload(bundleSubmissionId: unknown): {
  readonly bundle: CollectedBundle
  readonly payload: string
} {
  if (
    typeof bundleSubmissionId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(bundleSubmissionId)
  ) {
    throw new Error('bundleSubmissionId has invalid format')
  }
  prunePendingBundles()
  const pending = pendingBundles.get(bundleSubmissionId)
  if (!pending) {
    throw new Error('diagnostic bundle has expired; collect a new preview before uploading')
  }
  if (!pending.previewOpened) {
    throw new Error('open the diagnostic bundle preview before uploading')
  }
  // Why: the preview file is user-editable once opened in the OS. Upload only
  // the redacted bytes main collected and retained before preview.
  return { bundle: pending.bundle, payload: pending.bundle.payload }
}

function getPendingPreviewFilePath(bundleSubmissionId: unknown): string {
  if (
    typeof bundleSubmissionId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(bundleSubmissionId)
  ) {
    throw new Error('bundleSubmissionId has invalid format')
  }
  prunePendingBundles()
  const pending = pendingBundles.get(bundleSubmissionId)
  if (!pending) {
    throw new Error('diagnostic bundle has expired; collect a new preview before opening')
  }
  return pending.previewFilePath
}

function discardPendingBundle(bundleSubmissionId: unknown): void {
  if (
    typeof bundleSubmissionId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(bundleSubmissionId)
  ) {
    throw new Error('bundleSubmissionId has invalid format')
  }
  const pending = pendingBundles.get(bundleSubmissionId)
  if (pending) {
    deletePreviewFile(pending.previewFilePath)
    pendingBundles.delete(bundleSubmissionId)
  }
}

function getPreviewDirectory(): string {
  let base: string
  try {
    base = app.getPath('temp')
  } catch {
    base = tmpdir()
  }
  return join(base, 'orca-diagnostic-bundle-previews')
}

function writeBundlePreviewFile(bundle: CollectedBundle): string {
  const previewDirectory = getPreviewDirectory()
  mkdirSync(previewDirectory, { mode: 0o700, recursive: true })
  const previewFilePath = join(previewDirectory, `${bundle.bundleSubmissionId}.ndjson`)
  writeFileSync(previewFilePath, bundle.payload, { encoding: 'utf8', mode: 0o600 })
  return previewFilePath
}

function deletePreviewFile(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  } catch {
    /* best effort */
  }
}

function discardAllPendingBundles(): void {
  for (const pending of pendingBundles.values()) {
    deletePreviewFile(pending.previewFilePath)
  }
  pendingBundles.clear()
}

function isTicketId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value)
}

async function confirmBundleUpload(bundle: CollectedBundle): Promise<void> {
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Upload', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Upload diagnostic bundle?',
    message: 'Upload diagnostic bundle to Orca support?',
    detail: `Bundle ${bundle.bundleSubmissionId}\n${bundle.spanCount} span(s), ${Math.round(
      bundle.bytes / 1024
    )} KB\n\nThe exact redacted NDJSON preview was opened before this upload confirmation.`
  })
  if (result.response !== 0) {
    throw new Error('diagnostic bundle upload cancelled')
  }
}

export function registerDiagnosticsHandlers(): void {
  ipcMain.handle('diagnostics:getStatus', (): DiagnosticsStatus => {
    return getDiagnosticsStatus()
  })

  ipcMain.handle('diagnostics:openTraceFolder', async (): Promise<void> => {
    // Show the trace file's parent in the OS file manager. Using
    // `showItemInFolder` rather than `openPath(folder)` so the file itself
    // is highlighted — the user is much more likely to want to inspect
    // `main.trace.ndjson` than to browse the `logs/` directory.
    try {
      shell.showItemInFolder(getTraceFilePath())
    } catch {
      /* swallow — best effort; the user can navigate manually */
    }
  })

  ipcMain.handle('diagnostics:clearTraces', (): void => {
    discardAllPendingBundles()
    clearLocalTraces()
  })

  ipcMain.handle(
    'diagnostics:collectBundle',
    (_event, lookbackMinutesIn: unknown): DiagnosticsBundlePreview => {
      // Consent gate: main is the consent enforcement boundary; the
      // renderer-side button-hide is UX, not security. A compromised or
      // malicious renderer must not be able to assemble a bundle when the
      // user has disabled diagnostic-bundle collection in Settings → Privacy.
      const status = getDiagnosticsStatus()
      if (!status.bundleEnabled) {
        throw new Error('diagnostic bundle collection is disabled')
      }
      // Renderer-controlled input → narrow at the boundary. The default
      // (DEFAULT_LOOKBACK_MINUTES in bundle.ts) is fine for the common
      // "last 30 minutes" case the Privacy pane button triggers.
      const lookbackMinutes =
        typeof lookbackMinutesIn === 'number' && Number.isFinite(lookbackMinutesIn)
          ? Math.max(1, Math.min(30 * 24 * 60, Math.floor(lookbackMinutesIn)))
          : undefined
      const bundle = collectDiagnosticBundle({
        appVersion: app.getVersion(),
        platform: osPlatform(),
        arch: osArch(),
        osRelease: osRelease(),
        orcaChannel: resolveOrcaChannel(),
        ...(lookbackMinutes !== undefined ? { lookbackMinutes } : {})
      })
      rememberBundle(bundle)
      return toBundlePreview(bundle)
    }
  )

  ipcMain.handle(
    'diagnostics:uploadBundle',
    async (_event, bundleSubmissionId: unknown): Promise<UploadBundleResult> => {
      // Why: the renderer is in the threat model. Upload only a payload main
      // collected and retained for preview, never renderer-supplied bytes.
      const pendingForConfirmation = getPendingBundleForUpload(bundleSubmissionId)
      // Consent gate: main is the consent enforcement boundary; the
      // renderer-side button-hide is UX, not security. Re-check here in case
      // the user toggled the setting off between collect and upload.
      if (!getDiagnosticsStatus().bundleEnabled) {
        throw new Error('diagnostic bundle collection is disabled')
      }
      await confirmBundleUpload(pendingForConfirmation.bundle)
      // Why: the preview can be discarded or diagnostics can be disabled
      // while the native confirmation dialog is open.
      const { bundle, payload } = getPendingBundleForUpload(bundleSubmissionId)
      if (!getDiagnosticsStatus().bundleEnabled) {
        throw new Error('diagnostic bundle collection is disabled')
      }
      const tokenEndpoint = resolveTokenEndpoint()
      if (!tokenEndpoint) {
        throw new Error('diagnostic upload endpoint is not configured for this build')
      }
      const result = await uploadDiagnosticBundle({
        tokenEndpoint,
        payload,
        bundleSubmissionId: bundle.bundleSubmissionId
      })
      const uploadedPending = pendingBundles.get(bundle.bundleSubmissionId)
      if (uploadedPending) {
        deletePreviewFile(uploadedPending.previewFilePath)
      }
      pendingBundles.delete(bundle.bundleSubmissionId)
      return result
    }
  )

  ipcMain.handle('diagnostics:openBundlePreview', async (_event, bundleSubmissionId: unknown) => {
    const previewFilePath = getPendingPreviewFilePath(bundleSubmissionId)
    const errorMessage = await shell.openPath(previewFilePath)
    if (errorMessage) {
      throw new Error('could not open diagnostic bundle preview')
    }
    const pending = pendingBundles.get(bundleSubmissionId as string)
    if (pending) {
      pending.previewOpened = true
    }
  })

  ipcMain.handle('diagnostics:discardBundlePreview', (_event, bundleSubmissionId: unknown) => {
    discardPendingBundle(bundleSubmissionId)
  })

  ipcMain.handle('diagnostics:deleteBundle', async (_event, ticketId: unknown): Promise<void> => {
    if (!isTicketId(ticketId)) {
      throw new Error('ticketId has invalid format')
    }
    const tokenEndpoint = resolveTokenEndpoint()
    if (!tokenEndpoint) {
      throw new Error('diagnostic upload endpoint is not configured for this build')
    }
    await deleteDiagnosticBundle({ tokenEndpoint, ticketId })
  })
}
