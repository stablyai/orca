/**
 * `office.selection` and `office.marks` — the read side of what a reader pointed at in a live
 * preview, and of the advisory marks the watch process holds.
 *
 * Both answer from the watch process, so both are meaningless without one. Selection is shared by
 * every page connected to a watch server, last write wins; nothing here may assume it is private.
 */
import {
  officeFailure,
  type OfficeAckOutcome,
  type OfficeMark,
  type OfficeMarksOutcome,
  type OfficeSelectionNode,
  type OfficeSelectionOutcome
} from '../../shared/office-preview-contracts'
import { officeKindSupportsSelection, officeDocKind } from '../../shared/office-file-extensions'
import { resolveOfficeDocumentTarget } from './office-document-path'
import {
  classifyOfficecliRun,
  classifyOfficeThrown,
  officecliRunSucceeded
} from './office-error-codes'
import {
  officecliGotoArgs,
  officecliMarksArgs,
  officecliSelectionArgs,
  officecliUnmarkAllArgs
} from './officecli-argv'
import type { OfficeDocumentRef } from './office-local-execution'
import { runOfficecli } from './officecli-invocation'

const INSPECT_TIMEOUT_MS = 30_000

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** `get <f> selected --json` answers `{ success, data: { matches, results: [...] } }`. */
function readSelectionNodes(stdout: string): OfficeSelectionNode[] {
  const results = asRecord(asRecord(parseJson(stdout))?.data)?.results
  if (!Array.isArray(results)) {
    return []
  }
  const nodes: OfficeSelectionNode[] = []
  for (const entry of results) {
    const record = asRecord(entry)
    const path = record ? asString(record.path) : null
    if (path) {
      nodes.push({ path, type: asString(record?.type), text: asString(record?.text) })
    }
  }
  return nodes
}

/** `watch marks <f> --json` answers `{ version, marks: [...] }` — no success envelope. */
function readMarks(stdout: string): OfficeMark[] {
  const marks = asRecord(parseJson(stdout))?.marks
  if (!Array.isArray(marks)) {
    return []
  }
  const parsed: OfficeMark[] = []
  for (const entry of marks) {
    const record = asRecord(entry)
    const path = record ? asString(record.path) : null
    if (!record || !path) {
      continue
    }
    parsed.push({
      id: asString(record.id) ?? path,
      path,
      note: asString(record.note),
      color: asString(record.color),
      stale: record.stale === true
    })
  }
  return parsed
}

export async function readOfficeSelection(ref: OfficeDocumentRef): Promise<OfficeSelectionOutcome> {
  const kind = officeDocKind(ref.relativePath)
  if (!kind || !officeKindSupportsSelection(kind)) {
    // Stated, not discovered: `.xlsx` emits no addressable element paths, so the control says so
    // rather than silently answering with nothing.
    return officeFailure('OFFICECLI_UNSUPPORTED_FORMAT')
  }
  try {
    const canonicalPath = await resolveOfficeDocumentTarget(
      ref.workspaceRoot,
      ref.relativePath,
      ref.lane
    )
    const run = await runOfficecli(officecliSelectionArgs(canonicalPath), {
      lane: ref.lane,
      timeoutMs: INSPECT_TIMEOUT_MS,
      maxOutputBytes: 4 * 1024 * 1024
    })
    return officecliRunSucceeded(run)
      ? { ok: true, nodes: readSelectionNodes(run.stdout) }
      : classifyOfficecliRun(run, 'inspect')
  } catch (error) {
    return classifyOfficeThrown(error, 'inspect')
  }
}

export async function readOfficeMarks(ref: OfficeDocumentRef): Promise<OfficeMarksOutcome> {
  try {
    const canonicalPath = await resolveOfficeDocumentTarget(
      ref.workspaceRoot,
      ref.relativePath,
      ref.lane
    )
    const run = await runOfficecli(officecliMarksArgs(canonicalPath), {
      lane: ref.lane,
      timeoutMs: INSPECT_TIMEOUT_MS,
      maxOutputBytes: 4 * 1024 * 1024
    })
    // Marks answer with a bare object and exit 0 even when empty; a non-zero exit is the tool
    // saying no watch process holds this document.
    return run.code === 0
      ? { ok: true, marks: readMarks(run.stdout) }
      : classifyOfficecliRun(run, 'inspect')
  } catch (error) {
    return classifyOfficeThrown(error, 'inspect')
  }
}

export async function clearOfficeMarks(ref: OfficeDocumentRef): Promise<OfficeMarksOutcome> {
  try {
    const canonicalPath = await resolveOfficeDocumentTarget(
      ref.workspaceRoot,
      ref.relativePath,
      ref.lane
    )
    const run = await runOfficecli(officecliUnmarkAllArgs(canonicalPath), {
      lane: ref.lane,
      timeoutMs: INSPECT_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    return run.code === 0 ? { ok: true, marks: [] } : classifyOfficecliRun(run, 'inspect')
  } catch (error) {
    return classifyOfficeThrown(error, 'inspect')
  }
}

/**
 * Scrolls every page connected to the watch process to one element.
 *
 * Only meaningful while a live preview is open: `goto` is broadcast to the watch server's SSE
 * clients, and a snapshot is not one. The caller enables the control on the same evidence that
 * makes marks readable at all — a watch process holding this document.
 */
export async function gotoOfficeElement(
  ref: OfficeDocumentRef,
  elementPath: string
): Promise<OfficeAckOutcome> {
  try {
    const canonicalPath = await resolveOfficeDocumentTarget(
      ref.workspaceRoot,
      ref.relativePath,
      ref.lane
    )
    const run = await runOfficecli(officecliGotoArgs(canonicalPath, elementPath), {
      lane: ref.lane,
      timeoutMs: INSPECT_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    return run.code === 0 ? { ok: true } : classifyOfficecliRun(run, 'inspect')
  } catch (error) {
    return classifyOfficeThrown(error, 'inspect')
  }
}
