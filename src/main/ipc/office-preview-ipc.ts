/**
 * The renderer's way into Office preview.
 *
 * Two things this layer owns and the renderer does not: the rendered bytes, and the inline grant
 * that serves them. A snapshot is rendered on the owning host, held here, and answered as a
 * preview URL — so the document never crosses into the renderer, and the renderer can never mint
 * a grant over content it chose. Everything else is a pass-through to the owning host.
 */
import { ipcMain } from 'electron'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'
import { isValidOfficeHostOwner, type OfficeHostOwner } from '../../shared/office-host-owner'
import {
  OFFICE_CLEAR_MARKS_CHANNEL,
  OFFICE_GOTO_CHANNEL,
  OFFICE_MARKS_CHANNEL,
  OFFICE_OPEN_SNAPSHOT_CHANNEL,
  OFFICE_PROBE_CHANNEL,
  OFFICE_RELEASE_SNAPSHOT_CHANNEL,
  OFFICE_SELECTION_CHANNEL,
  OFFICE_SKILLS_INSTALL_CHANNEL,
  OFFICE_SKILLS_LIST_CHANNEL,
  OFFICE_WATCH_REFRESH_CHANNEL,
  OFFICE_WATCH_START_CHANNEL,
  OFFICE_WATCH_STOP_CHANNEL,
  type OfficeDocumentRequest,
  type OfficeElementRequest,
  type OfficeProbeRequest,
  type OfficeSkillsInstallRequest,
  type OfficeSkillsListRequest,
  type OfficeSnapshotRequest,
  type OfficeSnapshotResult
} from '../../shared/office-preview-channels'
import { officeFailure, type OfficeMethodResult } from '../../shared/office-preview-contracts'
import {
  isValidOfficeDocumentPath,
  parseOfficeSkillInstallPairs,
  isValidOfficeElementPath,
  OFFICE_CLEAR_MARKS_METHOD,
  OFFICE_GOTO_METHOD,
  OFFICE_MARKS_METHOD,
  OFFICE_PROBE_METHOD,
  OFFICE_SELECTION_METHOD,
  OFFICE_SKILLS_INSTALL_METHOD,
  OFFICE_SKILLS_LIST_METHOD,
  OFFICE_WATCH_REFRESH_METHOD,
  OFFICE_WATCH_START_METHOD,
  OFFICE_WATCH_STOP_METHOD,
  type OfficeRpcMethod
} from '../../shared/office-preview-rpc'
import { browserManager } from '../browser/browser-manager'
import {
  INLINE_DOC_PREVIEW_ENTRY,
  mintInlineDocPreviewGrant,
  revokeDocPreviewGrant
} from '../browser/doc-preview-grant-registry'
import { dispatchOfficeRequest, renderOfficeOnHost } from '../office/office-host-dispatch'
import { forgetOfficeWatch, rememberOfficeWatch } from '../office/office-watch-client-ledger'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const SNAPSHOT_CONTENT_TYPE = 'text/html; charset=utf-8'

function ownerOf(request: unknown): OfficeHostOwner | null {
  const owner = (request as { owner?: unknown } | null)?.owner
  return isValidOfficeHostOwner(owner) ? owner : null
}

function documentPathOf(request: unknown): string | null {
  const path = (request as { path?: unknown } | null)?.path
  return isValidOfficeDocumentPath(path) ? path : null
}

/** Every handler answers a typed failure rather than throwing: the caller is a preview surface,
 *  and an exception it cannot classify becomes a spinner that never resolves. */
function refused(): OfficeMethodResult {
  return officeFailure('OFFICECLI_FILE_NOT_FOUND', 'Invalid Office preview request')
}

function handleDocumentMethod(channel: string, method: OfficeRpcMethod): void {
  ipcMain.handle(channel, async (event, request: OfficeDocumentRequest) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      throw new Error('Untrusted Office preview request')
    }
    const owner = ownerOf(request)
    const path = documentPathOf(request)
    return owner && path ? dispatchOfficeRequest(owner, method, { path }) : refused()
  })
}

export function registerOfficePreviewHandlers(): void {
  ipcMain.handle(OFFICE_PROBE_CHANNEL, async (event, request: OfficeProbeRequest) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      throw new Error('Untrusted Office preview request')
    }
    const owner = ownerOf(request)
    if (!owner) {
      return refused()
    }
    const path = documentPathOf(request)
    return dispatchOfficeRequest(owner, OFFICE_PROBE_METHOD, {
      ...(path ? { path } : {}),
      ...(request?.refresh === true ? { refresh: true } : {})
    })
  })

  ipcMain.handle(
    OFFICE_OPEN_SNAPSHOT_CHANNEL,
    async (event, request: OfficeSnapshotRequest): Promise<OfficeSnapshotResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        throw new Error('Untrusted Office preview request')
      }
      const owner = ownerOf(request)
      const path = documentPathOf(request)
      const browserPageId = request?.browserPageId
      if (!owner || !path || typeof browserPageId !== 'string' || !browserPageId.trim()) {
        return { ok: false, code: 'OFFICECLI_FILE_NOT_FOUND' }
      }
      // Same disjointness rule the file-backed mint holds: a page already hosting a browsing guest
      // must not also resolve as a document page, or one id would answer in both registries.
      if (browserManager.getGuestWebContentsId(browserPageId) !== null) {
        return { ok: false, code: 'OFFICECLI_RENDER_FAILED', detail: 'Page is a browsing page' }
      }
      const rendered = await renderOfficeOnHost(owner, path)
      if (!rendered.ok) {
        return {
          ok: false,
          code: rendered.code,
          ...(rendered.detail ? { detail: rendered.detail } : {})
        }
      }
      const grant = mintInlineDocPreviewGrant({
        documents: new Map([
          [
            INLINE_DOC_PREVIEW_ENTRY,
            { bytes: Buffer.from(rendered.html, 'utf8'), contentType: SNAPSHOT_CONTENT_TYPE }
          ]
        ]),
        browserPageId
      })
      return {
        ok: true,
        grantId: grant.id,
        url: buildDocPreviewUrl(grant.id, grant.entryRelativePath),
        kind: rendered.kind
      }
    }
  )

  ipcMain.handle(OFFICE_RELEASE_SNAPSHOT_CHANNEL, (event, grantId: unknown): boolean =>
    isTrustedBrowserRenderer(event.sender) && typeof grantId === 'string'
      ? revokeDocPreviewGrant(grantId)
      : false
  )

  // Why the two watch-lifetime channels are not plain pass-throughs: the client has to keep its own
  // record of what it asked a host to watch, or a renderer reload orphans a live process on a
  // machine this client can still reach but no longer remembers.
  ipcMain.handle(OFFICE_WATCH_START_CHANNEL, async (event, request: OfficeDocumentRequest) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      throw new Error('Untrusted Office preview request')
    }
    const owner = ownerOf(request)
    const path = documentPathOf(request)
    if (!owner || !path) {
      return refused()
    }
    const outcome = await dispatchOfficeRequest(owner, OFFICE_WATCH_START_METHOD, { path })
    if (outcome.ok) {
      rememberOfficeWatch(owner, path)
    }
    return outcome
  })

  ipcMain.handle(OFFICE_WATCH_STOP_CHANNEL, async (event, request: OfficeDocumentRequest) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      throw new Error('Untrusted Office preview request')
    }
    const owner = ownerOf(request)
    const path = documentPathOf(request)
    if (!owner || !path) {
      return refused()
    }
    // Forgotten before the call, not after: a stop that fails must not leave a record this client
    // would retry forever against a host that no longer has the session.
    forgetOfficeWatch(owner, path)
    return dispatchOfficeRequest(owner, OFFICE_WATCH_STOP_METHOD, { path })
  })

  handleDocumentMethod(OFFICE_WATCH_REFRESH_CHANNEL, OFFICE_WATCH_REFRESH_METHOD)
  handleDocumentMethod(OFFICE_SELECTION_CHANNEL, OFFICE_SELECTION_METHOD)
  handleDocumentMethod(OFFICE_MARKS_CHANNEL, OFFICE_MARKS_METHOD)
  handleDocumentMethod(OFFICE_CLEAR_MARKS_CHANNEL, OFFICE_CLEAR_MARKS_METHOD)

  ipcMain.handle(OFFICE_GOTO_CHANNEL, async (event, request: OfficeElementRequest) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      throw new Error('Untrusted Office preview request')
    }
    const owner = ownerOf(request)
    const path = documentPathOf(request)
    return owner && path && isValidOfficeElementPath(request?.elementPath)
      ? dispatchOfficeRequest(owner, OFFICE_GOTO_METHOD, {
          path,
          elementPath: request.elementPath
        })
      : refused()
  })

  ipcMain.handle(OFFICE_SKILLS_LIST_CHANNEL, async (event, request: OfficeSkillsListRequest) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      throw new Error('Untrusted Office preview request')
    }
    const owner = ownerOf(request)
    if (!owner) {
      return refused()
    }
    const path = documentPathOf(request)
    return dispatchOfficeRequest(owner, OFFICE_SKILLS_LIST_METHOD, path ? { path } : {})
  })

  ipcMain.handle(
    OFFICE_SKILLS_INSTALL_CHANNEL,
    async (event, request: OfficeSkillsInstallRequest) => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        throw new Error('Untrusted Office preview request')
      }
      const owner = ownerOf(request)
      const pairs = parseOfficeSkillInstallPairs(request?.pairs)
      if (!owner || !pairs) {
        return refused()
      }
      const path = documentPathOf(request)
      return dispatchOfficeRequest(owner, OFFICE_SKILLS_INSTALL_METHOD, {
        pairs,
        ...(path ? { path } : {})
      })
    }
  )
}
