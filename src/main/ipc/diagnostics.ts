// IPC surface for the error-tracking lane (telemetry-error-tracking.md
// §User controls). Six renderer-facing channels:
//
//   diagnostics:getStatus            — read-only snapshot for the Privacy pane.
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
  collectDiagnosticBundle,
  deleteDiagnosticBundle,
  getDiagnosticsStatus,
  uploadDiagnosticBundle,
  type DiagnosticsStatus
} from '../observability'
import type { CollectedBundle } from '../observability/bundle'
import type { UploadBundleResult } from '../observability/diagnostic-bundle-upload'
import {
  resolveDiagnosticOrcaChannel,
  resolveDiagnosticTokenEndpoint
} from '../observability/diagnostic-upload-endpoint'

export type DiagnosticsBundlePreview = Omit<CollectedBundle, 'payload'>
type UploadBundleIpcResult = UploadBundleResult | { canceled: true }

const PENDING_BUNDLE_TTL_MS = 15 * 60 * 1000
const MAX_PENDING_BUNDLES = 8

type PendingBundle = {
  bundle: CollectedBundle
  readonly createdAtMs: number
  readonly previewFilePath: string
  ttlTimer: ReturnType<typeof setTimeout>
  previewOpened: boolean
}

const pendingBundles = new Map<string, PendingBundle>()

function prunePendingBundles(now = Date.now()): void {
  for (const [id, pending] of pendingBundles) {
    if (now - pending.createdAtMs > PENDING_BUNDLE_TTL_MS) {
      deletePendingBundle(id)
    }
  }
  while (pendingBundles.size > MAX_PENDING_BUNDLES) {
    const oldest = pendingBundles.keys().next().value as string | undefined
    if (!oldest) {
      break
    }
    deletePendingBundle(oldest)
  }
}

function rememberBundle(bundle: CollectedBundle): void {
  deletePendingBundle(bundle.bundleSubmissionId)
  const previewFilePath = writeBundlePreviewFile(bundle)
  pendingBundles.set(bundle.bundleSubmissionId, {
    bundle,
    createdAtMs: Date.now(),
    previewFilePath,
    // Why: diagnostics previews retain redacted payload bytes in main; the
    // documented TTL must expire even if the renderer never makes another call.
    ttlTimer: schedulePendingBundleExpiry(bundle.bundleSubmissionId),
    previewOpened: false
  })
  prunePendingBundles()
}

function schedulePendingBundleExpiry(bundleSubmissionId: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    deletePendingBundle(bundleSubmissionId)
  }, PENDING_BUNDLE_TTL_MS)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
  return timer
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
    throw new Error('review file has expired; create a new one before sending')
  }
  if (!pending.previewOpened) {
    throw new Error('open the review file before sending')
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
    throw new Error('review file has expired; create a new one before opening')
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
  deletePendingBundle(bundleSubmissionId)
}

function deletePendingBundle(bundleSubmissionId: string): void {
  const pending = pendingBundles.get(bundleSubmissionId)
  if (pending) {
    clearTimeout(pending.ttlTimer)
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

function isTicketId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value)
}

async function confirmBundleUpload(bundle: CollectedBundle): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Send', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Send this file to support?',
    message: 'This uploads the redacted app diagnostics file you reviewed.',
    detail: `Diagnostic ID: ${bundle.bundleSubmissionId}\nDiagnostic records: ${bundle.spanCount}\nSize: ${Math.round(
      bundle.bytes / 1024
    )} KB`
  })
  return result.response === 0
}

export function registerDiagnosticsHandlers(): void {
  ipcMain.handle('diagnostics:getStatus', (): DiagnosticsStatus => {
    return getDiagnosticsStatus()
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
        throw new Error('creating review files is disabled')
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
        orcaChannel: resolveDiagnosticOrcaChannel(),
        ...(lookbackMinutes !== undefined ? { lookbackMinutes } : {})
      })
      rememberBundle(bundle)
      return toBundlePreview(bundle)
    }
  )

  ipcMain.handle(
    'diagnostics:uploadBundle',
    async (_event, bundleSubmissionId: unknown): Promise<UploadBundleIpcResult> => {
      // Why: the renderer is in the threat model. Upload only a payload main
      // collected and retained for preview, never renderer-supplied bytes.
      const pendingForConfirmation = getPendingBundleForUpload(bundleSubmissionId)
      // Consent gate: main is the consent enforcement boundary; the
      // renderer-side button-hide is UX, not security. Re-check here in case
      // the user toggled the setting off between collect and upload.
      if (!getDiagnosticsStatus().bundleEnabled) {
        throw new Error('sending diagnostics is disabled')
      }
      const confirmed = await confirmBundleUpload(pendingForConfirmation.bundle)
      if (!confirmed) {
        return { canceled: true }
      }
      // Why: the preview can be discarded or diagnostics can be disabled
      // while the native confirmation dialog is open.
      const { bundle, payload } = getPendingBundleForUpload(bundleSubmissionId)
      if (!getDiagnosticsStatus().bundleEnabled) {
        throw new Error('sending diagnostics is disabled')
      }
      const tokenEndpoint = resolveDiagnosticTokenEndpoint()
      if (!tokenEndpoint) {
        throw new Error('sending diagnostics is not configured for this build')
      }
      const result = await uploadDiagnosticBundle({
        tokenEndpoint,
        payload,
        bundleSubmissionId: bundle.bundleSubmissionId
      })
      const uploadedPending = pendingBundles.get(bundle.bundleSubmissionId)
      if (uploadedPending) {
        deletePendingBundle(bundle.bundleSubmissionId)
      }
      return result
    }
  )

  ipcMain.handle('diagnostics:openBundlePreview', async (_event, bundleSubmissionId: unknown) => {
    const previewFilePath = getPendingPreviewFilePath(bundleSubmissionId)
    const errorMessage = await shell.openPath(previewFilePath)
    if (errorMessage) {
      throw new Error('could not open review file')
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
    const tokenEndpoint = resolveDiagnosticTokenEndpoint()
    if (!tokenEndpoint) {
      throw new Error('diagnostic upload endpoint is not configured for this build')
    }
    await deleteDiagnosticBundle({ tokenEndpoint, ticketId })
  })
}
