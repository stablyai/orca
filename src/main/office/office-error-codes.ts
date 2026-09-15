/**
 * Turning what `officecli` said into the stable code vocabulary.
 *
 * The vocabulary itself lives in `src/shared/office-preview-contracts.ts`, because the renderer
 * owns every reader-facing sentence and needs the same list. This module is the host side: one
 * classifier, shared by the local implementation, the SSH relay handler and the paired-runtime
 * methods, so the same refusal cannot be named three different things depending on the host.
 *
 * The distinction that matters most: a format the tool refuses is `OFFICECLI_UNSUPPORTED_FORMAT`,
 * never `OFFICECLI_NOT_FOUND`. Getting it backwards produces the exact failure the plan set out to
 * avoid — telling a reader to install a tool that was never the problem.
 */
import {
  officeFailure,
  type OfficeErrorCode,
  type OfficeFailure
} from '../../shared/office-preview-contracts'
import { OfficecliMissingError } from './officecli-invocation'
import type { OfficecliRun } from './officecli-invocation'

/** Both streams: the JSON envelope goes to stdout, plain refusals to stderr. */
function runText(run: OfficecliRun): string {
  return `${run.stdout}\n${run.stderr}`
}

function machineCode(run: OfficecliRun): string | null {
  const match = /"code"\s*:\s*"([a-z_]+)"/.exec(run.stdout)
  return match?.[1] ?? null
}

export function officecliRunSucceeded(run: OfficecliRun): boolean {
  return run.code === 0 && !/"success"\s*:\s*false/.test(run.stdout)
}

/**
 * The port an already-running watch server reported.
 *
 * 1.0.148 refuses a second watch with `Another watch process is already running at
 * http://localhost:26315 for <path>`. That URL is the existing session, so a client that lost
 * track of its own watch — an Orca restart, a reconnect — can adopt it instead of telling the
 * reader to go find and kill a process.
 */
export function parseAlreadyWatchedPort(text: string): number | null {
  const match = /already running at\s+https?:\/\/[^:/\s]+:(\d{1,5})/i.exec(text)
  const port = match ? Number(match[1]) : Number.NaN
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

export type OfficeOperationKind = 'probe' | 'render' | 'watch' | 'inspect'

const FALLBACK_BY_OPERATION: Record<OfficeOperationKind, OfficeErrorCode> = {
  probe: 'OFFICECLI_NOT_FOUND',
  render: 'OFFICECLI_RENDER_FAILED',
  watch: 'OFFICECLI_WATCH_FAILED',
  inspect: 'OFFICECLI_RENDER_FAILED'
}

/** Trimmed diagnostic for the expandable row. Never the reader's headline. */
export function officecliDetail(run: OfficecliRun): string | undefined {
  const jsonError = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(run.stdout)?.[1]
  const raw = jsonError ?? run.stderr.trim() ?? ''
  const collapsed = raw.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
  return collapsed ? collapsed.slice(0, 400) : undefined
}

export function classifyOfficecliRun(
  run: OfficecliRun,
  operation: OfficeOperationKind
): OfficeFailure {
  const text = runText(run)
  const detail = officecliDetail(run)
  if (run.timedOut) {
    return officeFailure(
      operation === 'watch' ? 'OFFICECLI_PORT_TIMEOUT' : FALLBACK_BY_OPERATION[operation],
      detail
    )
  }
  if (machineCode(run) === 'unsupported_type' || /unsupported file type/i.test(text)) {
    return officeFailure('OFFICECLI_UNSUPPORTED_FORMAT', detail)
  }
  if (/file not found|no such file/i.test(text)) {
    return officeFailure('OFFICECLI_FILE_NOT_FOUND', detail)
  }
  if (/another watch process is already running/i.test(text)) {
    return officeFailure('OFFICECLI_ALREADY_WATCHED', detail)
  }
  if (/no watch running/i.test(text)) {
    return officeFailure('OFFICE_WATCH_NOT_RUNNING', detail)
  }
  return officeFailure(FALLBACK_BY_OPERATION[operation], detail)
}

/** A thrown error, as opposed to a process that ran and refused. */
export function classifyOfficeThrown(
  error: unknown,
  operation: OfficeOperationKind
): OfficeFailure {
  if (error instanceof OfficecliMissingError) {
    return officeFailure('OFFICECLI_NOT_FOUND')
  }
  const detail = error instanceof Error ? error.message : undefined
  return officeFailure(FALLBACK_BY_OPERATION[operation], detail)
}

/**
 * `POST /api/switch` rejections, documented by the tool and verified against 1.0.148.
 * Every one of them is safe to report as "the refresh did not happen": the server keeps serving
 * the document it already had when a switch fails.
 */
export function classifySwitchStatus(status: number, detail?: string): OfficeFailure {
  switch (status) {
    case 404:
      return officeFailure('OFFICECLI_FILE_NOT_FOUND', detail)
    case 409:
      return officeFailure('OFFICECLI_ALREADY_WATCHED', detail)
    case 400:
      return officeFailure('OFFICECLI_UNSUPPORTED_FORMAT', detail)
    default:
      return officeFailure('OFFICECLI_WATCH_FAILED', detail ?? `HTTP ${status}`)
  }
}

export { officeFailure }
export type { OfficeErrorCode, OfficeFailure }
