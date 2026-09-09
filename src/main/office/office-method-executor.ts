/**
 * One method table for the office surface, shared by the SSH relay handler and the paired-runtime
 * RPC methods. Both are "this process is the owning host" — the only differences are the transport
 * and, for the runtime, capability gating. Keeping the table here is what makes relay-vs-runtime
 * parity a property of the code rather than a test that has to keep catching drift.
 */
import { officeFailure, type OfficeMethodResult } from '../../shared/office-preview-contracts'
import {
  isValidOfficeDocumentPath,
  isValidOfficeRelativePath,
  parseOfficeSkillInstallPairs,
  isValidOfficeElementPath,
  OFFICE_CLEAR_MARKS_METHOD,
  OFFICE_GOTO_METHOD,
  OFFICE_MARKS_METHOD,
  OFFICE_PROBE_METHOD,
  OFFICE_RENDER_METHOD,
  OFFICE_SELECTION_METHOD,
  OFFICE_SKILLS_INSTALL_METHOD,
  OFFICE_SKILLS_LIST_METHOD,
  OFFICE_WATCH_REFRESH_METHOD,
  OFFICE_WATCH_START_METHOD,
  OFFICE_WATCH_STOP_METHOD,
  type OfficeRpcMethod
} from '../../shared/office-preview-rpc'
import {
  clearOfficeMarksLocally,
  gotoOfficeElementLocally,
  installOfficeSkillsLocally,
  invalidateOfficeProbeForWorkspace,
  officeDocumentRef,
  listOfficeSkillsLocally,
  probeOfficeForWorkspace,
  readOfficeMarksLocally,
  readOfficeSelectionLocally,
  refreshOfficeWatchLocally,
  renderOfficeLocally,
  startOfficeWatchLocally,
  stopOfficeWatchLocally,
  type OfficeDocumentRef
} from './office-local-execution'

function optionalWorkspaceRoot(params: unknown): string | undefined {
  const candidate = (params as { workspaceRoot?: unknown } | null)?.workspaceRoot
  return isValidOfficeDocumentPath(candidate) ? candidate : undefined
}

/** The (root, relative) pair every document method names, or null when either half is unusable. */
function documentRef(params: unknown): OfficeDocumentRef | null {
  const root = optionalWorkspaceRoot(params)
  const relativePath = (params as { relativePath?: unknown } | null)?.relativePath
  return root && isValidOfficeRelativePath(relativePath)
    ? officeDocumentRef(root, relativePath)
    : null
}

/** Resolves the (root, relative) pair a document method needs, or the typed refusal to answer. */
async function withDocument(
  params: unknown,
  run: (ref: OfficeDocumentRef) => Promise<OfficeMethodResult>
): Promise<OfficeMethodResult> {
  const ref = documentRef(params)
  return ref
    ? run(ref)
    : officeFailure(
        'OFFICECLI_FILE_NOT_FOUND',
        'A workspace root and a path inside it are both required'
      )
}

/**
 * Runs one office method on this machine.
 *
 * One exhaustive switch with no `default`, so adding a method to `OFFICE_RPC_METHODS` without
 * handling it here is a compile error rather than a refusal discovered at runtime.
 *
 * A document that cannot be bound to a workspace is `OFFICECLI_FILE_NOT_FOUND` rather than a
 * thrown protocol error: the caller is a preview surface, and a typed failure it can render beats
 * an exception it has to guess at.
 */
export async function executeOfficeMethod(
  method: OfficeRpcMethod,
  params: unknown
): Promise<OfficeMethodResult> {
  switch (method) {
    case OFFICE_PROBE_METHOD: {
      const workspaceRoot = optionalWorkspaceRoot(params)
      if ((params as { refresh?: unknown } | null)?.refresh === true) {
        // Why the host and not the client caches this: a cached "not installed" surviving the
        // install the reader just ran is how a preview keeps asking for what already happened.
        invalidateOfficeProbeForWorkspace(workspaceRoot)
      }
      return probeOfficeForWorkspace(workspaceRoot)
    }
    case OFFICE_SKILLS_LIST_METHOD:
      return listOfficeSkillsLocally(optionalWorkspaceRoot(params))
    case OFFICE_SKILLS_INSTALL_METHOD: {
      const pairs = parseOfficeSkillInstallPairs((params as { pairs?: unknown } | null)?.pairs)
      return pairs
        ? installOfficeSkillsLocally(pairs, optionalWorkspaceRoot(params))
        : officeFailure('OFFICECLI_RENDER_FAILED', 'No valid skill/agent pairs were requested')
    }
    case OFFICE_RENDER_METHOD:
      return withDocument(params, renderOfficeLocally)
    case OFFICE_WATCH_START_METHOD:
      return withDocument(params, startOfficeWatchLocally)
    case OFFICE_WATCH_REFRESH_METHOD:
      return withDocument(params, refreshOfficeWatchLocally)
    case OFFICE_WATCH_STOP_METHOD:
      return withDocument(params, stopOfficeWatchLocally)
    case OFFICE_SELECTION_METHOD:
      return withDocument(params, readOfficeSelectionLocally)
    case OFFICE_MARKS_METHOD:
      return withDocument(params, readOfficeMarksLocally)
    case OFFICE_CLEAR_MARKS_METHOD:
      return withDocument(params, clearOfficeMarksLocally)
    case OFFICE_GOTO_METHOD: {
      const elementPath = (params as { elementPath?: unknown } | null)?.elementPath
      return isValidOfficeElementPath(elementPath)
        ? withDocument(params, (ref) => gotoOfficeElementLocally(ref, elementPath))
        : officeFailure('OFFICECLI_RENDER_FAILED', 'No element path was supplied')
    }
  }
}
