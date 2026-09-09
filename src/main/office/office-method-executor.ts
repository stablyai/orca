/**
 * One method table for the office surface, shared by the SSH relay handler and the paired-runtime
 * RPC methods. Both are "this process is the owning host" — the only differences are the transport
 * and, for the runtime, capability gating. Keeping the table here is what makes relay-vs-runtime
 * parity a property of the code rather than a test that has to keep catching drift.
 */
import { officeFailure, type OfficeMethodResult } from '../../shared/office-preview-contracts'
import {
  isValidOfficeDocumentPath,
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
  invalidateOfficeProbeForDocument,
  listOfficeSkillsLocally,
  probeOfficeForDocument,
  readOfficeMarksLocally,
  readOfficeSelectionLocally,
  refreshOfficeWatchLocally,
  renderOfficeLocally,
  startOfficeWatchLocally,
  stopOfficeWatchLocally
} from './office-local-execution'

function optionalPath(params: unknown): string | undefined {
  const candidate = (params as { path?: unknown } | null)?.path
  return isValidOfficeDocumentPath(candidate) ? candidate : undefined
}

function requiredPath(params: unknown): string | null {
  return optionalPath(params) ?? null
}

/**
 * Runs one office method on this machine.
 *
 * An invalid path is `OFFICECLI_FILE_NOT_FOUND` rather than a thrown protocol error: the caller is
 * a preview surface, and a typed failure it can render beats an exception it has to guess at.
 */
export async function executeOfficeMethod(
  method: OfficeRpcMethod,
  params: unknown
): Promise<OfficeMethodResult> {
  switch (method) {
    case OFFICE_PROBE_METHOD: {
      const path = optionalPath(params)
      if ((params as { refresh?: unknown } | null)?.refresh === true) {
        // Why the host and not the client caches this: a cached "not installed" surviving the
        // install the reader just ran is how a preview keeps asking for what already happened.
        invalidateOfficeProbeForDocument(path)
      }
      return probeOfficeForDocument(path)
    }
    case OFFICE_SKILLS_LIST_METHOD:
      return listOfficeSkillsLocally(optionalPath(params))
    case OFFICE_SKILLS_INSTALL_METHOD: {
      const pairs = parseOfficeSkillInstallPairs((params as { pairs?: unknown } | null)?.pairs)
      return pairs
        ? installOfficeSkillsLocally(pairs, optionalPath(params))
        : officeFailure('OFFICECLI_RENDER_FAILED', 'No valid skill/agent pairs were requested')
    }
    default:
      break
  }
  const path = requiredPath(params)
  if (!path) {
    return officeFailure('OFFICECLI_FILE_NOT_FOUND', 'No document path was supplied')
  }
  switch (method) {
    case OFFICE_RENDER_METHOD:
      return renderOfficeLocally(path)
    case OFFICE_WATCH_START_METHOD:
      return startOfficeWatchLocally(path)
    case OFFICE_WATCH_REFRESH_METHOD:
      return refreshOfficeWatchLocally(path)
    case OFFICE_WATCH_STOP_METHOD:
      return stopOfficeWatchLocally(path)
    case OFFICE_SELECTION_METHOD:
      return readOfficeSelectionLocally(path)
    case OFFICE_MARKS_METHOD:
      return readOfficeMarksLocally(path)
    case OFFICE_CLEAR_MARKS_METHOD:
      return clearOfficeMarksLocally(path)
    case OFFICE_GOTO_METHOD: {
      const elementPath = (params as { elementPath?: unknown } | null)?.elementPath
      return isValidOfficeElementPath(elementPath)
        ? gotoOfficeElementLocally(path, elementPath)
        : officeFailure('OFFICECLI_RENDER_FAILED', 'No element path was supplied')
    }
    default:
      return officeFailure('OFFICECLI_RENDER_FAILED', `Unknown office method ${String(method)}`)
  }
}
