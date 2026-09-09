/**
 * Routing one office request to the host that owns the document.
 *
 * The governing rule, from docs/reference/ssh-execution-boundary.md: the execution host owns
 * everything that touches execution. A worktree on an SSH host renders with that host's
 * `officecli`, its fonts and its locale. A missing or unreachable provider is an error — never
 * permission to render on the client instead.
 */
import {
  officeFailure,
  type OfficeMethodResult,
  type OfficeRenderOutcome
} from '../../shared/office-preview-contracts'
import type { OfficeDocKind } from '../../shared/office-file-extensions'
import { officeHostOwnerKey, type OfficeHostOwner } from '../../shared/office-host-owner'
import { OFFICE_RENDER_METHOD, type OfficeRpcMethod } from '../../shared/office-preview-rpc'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { getCanonicalUserDataPath } from '../persistence'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { executeOfficeMethod } from './office-method-executor'

/** Rendering a media-heavy deck on a remote host is slow; this is a render budget, not a ping. */
const RUNTIME_OFFICE_TIMEOUT_MS = 180_000

export { officeHostOwnerKey }
export type { OfficeHostOwner }

export async function dispatchOfficeRequest(
  owner: OfficeHostOwner,
  method: OfficeRpcMethod,
  params: Record<string, unknown> | undefined
): Promise<OfficeMethodResult> {
  switch (owner.kind) {
    case 'local':
      return executeOfficeMethod(method, params)
    case 'ssh': {
      const provider = getSshFilesystemProvider(owner.connectionId)
      if (!provider?.officeRequest) {
        // Not "render it here": an unreachable SSH host is `unverifiable`, and falling back to the
        // client would render the wrong machine's idea of the document.
        return officeFailure('OFFICE_HOST_UNREACHABLE')
      }
      return provider.officeRequest(method, params)
    }
    case 'runtime': {
      const response = await callRuntimeEnvironment(
        getCanonicalUserDataPath(),
        owner.environmentId,
        method,
        params ?? {},
        RUNTIME_OFFICE_TIMEOUT_MS
      ).catch((error: unknown) => ({
        ok: false as const,
        error: {
          code: 'transport_error',
          message: error instanceof Error ? error.message : 'The paired machine did not answer'
        }
      }))
      if (response.ok) {
        return response.result as OfficeMethodResult
      }
      // Fail closed on an old host, the way `doc-preview-file-reader` already does for scoped
      // reads: `method_not_found` means the paired machine predates `office.preview.v1`, and the
      // raw wording reads as a broken preview rather than an out-of-date machine.
      return response.error.code === 'method_not_found'
        ? officeFailure('OFFICE_HOST_UPDATE_REQUIRED')
        : officeFailure('OFFICE_HOST_UNREACHABLE', response.error.message)
    }
  }
}

function isOfficeDocKind(value: unknown): value is OfficeDocKind {
  return value === 'word' || value === 'excel' || value === 'ppt'
}

/**
 * Typed narrowing for the one call whose success shape the caller reads. Everything else the
 * renderer forwards untouched, but `office:openSnapshot` mints a grant from the HTML and needs it
 * to be HTML, not "one of eight outcome shapes".
 */
export async function renderOfficeOnHost(
  owner: OfficeHostOwner,
  path: string
): Promise<OfficeRenderOutcome> {
  const outcome = await dispatchOfficeRequest(owner, OFFICE_RENDER_METHOD, { path })
  if (!outcome.ok) {
    return outcome
  }
  const rendered = outcome as { ok: true; html?: unknown; kind?: unknown }
  return typeof rendered.html === 'string' && isOfficeDocKind(rendered.kind)
    ? { ok: true, html: rendered.html, kind: rendered.kind }
    : officeFailure('OFFICECLI_RENDER_FAILED', 'The host answered a render with no document')
}
