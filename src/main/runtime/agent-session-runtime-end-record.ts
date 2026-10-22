// What each Orca runtime that ran chats here says about itself: that it started, and, when it ends
// gracefully, how (a quit or an update). A later start reads them to tell an owner that died with a
// quit from one that died in a crash. A crash is only ever concluded from a runtime known to have
// started and never ended; a runtime with no readable record names no cause.
//
// One file per runtime, written only by that runtime, so two processes sharing the directory never
// lose each other's word to a read-modify-write. Pruned to the newest few, and losing a record only
// costs the distinction.

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import type { AgentSessionOrcaStopCause } from '../../shared/agent-session-orca-stop'
import {
  AGENT_SESSION_RESUME_TRIGGERS,
  type AgentSessionResumeTrigger
} from '../../shared/agent-session-resume-marker'

const RUNTIMES_DIRECTORY = 'agent-session-runtimes'
/** Enough runtimes that an owner a few restarts old still finds its runtime's record. */
const MAX_RUNTIME_RECORDS = 16
const MAX_RUNTIME_RECORD_BYTES = 4 * 1024
/** A temp file older than this belongs to a writer that died between write and rename. */
const STALE_TEMP_FILE_MS = 60_000
const RECORD_FILE = /^([A-Za-z0-9-]{1,64})\.json$/

type RuntimeRecord = {
  runtime: string
  startedAt: number
  end?: { trigger: AgentSessionResumeTrigger; at: number }
}

/** This process's runtime, once its store opened: the one record a graceful end rewrites. */
let current: { path: string; record: RuntimeRecord } | null = null

function writeRecord(path: string, record: RuntimeRecord): void {
  writeFileDurableSync(durableWriteTempPath(path), path, JSON.stringify(record))
}

function prune(directory: string, keep: string): void {
  const records: { name: string; modifiedAt: number }[] = []
  for (const name of readdirSync(directory)) {
    const modifiedAt = statSync(join(directory, name), { throwIfNoEntry: false })?.mtimeMs ?? 0
    if (name.endsWith('.tmp')) {
      if (Date.now() - modifiedAt > STALE_TEMP_FILE_MS) {
        rmSync(join(directory, name), { force: true })
      }
    } else if (name !== keep) {
      records.push({ name, modifiedAt })
    }
  }
  records.sort((a, b) => b.modifiedAt - a.modifiedAt)
  for (const { name } of records.slice(MAX_RUNTIME_RECORDS - 1)) {
    rmSync(join(directory, name), { force: true })
  }
}

/** A graceful exit no call site recorded, such as an `app.exit(0)` or `process.exit(0)`, is a quit:
 *  Electron emits the process's 'exit' on every quit or exit once its loop runs, and Node on every
 *  `process.exit`. A non-zero exit records nothing, so it stays a crash. */
export function recordAgentSessionRuntimeEndOnExit(code: number): void {
  if (code === 0) {
    recordAgentSessionRuntimeEnd('quit')
  }
}

let exitHookInstalled = false

/** Records that this runtime started. Never throws: a runtime with no record reads as unknown. A
 *  second start of the same runtime (a host reinstalled during its quit) keeps the end it recorded. */
export function beginAgentSessionRuntimeRecord(
  stateDirectory: string,
  runtime: string,
  now: number
): void {
  const directory = join(stateDirectory, RUNTIMES_DIRECTORY)
  const name = `${runtime}.json`
  const path = join(directory, name)
  const ended = current?.path === path && current.record.end ? current.record : null
  current = { path, record: ended ?? { runtime, startedAt: now } }
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once('exit', recordAgentSessionRuntimeEndOnExit)
  }
  try {
    mkdirSync(directory, { recursive: true })
    writeRecord(current.path, current.record)
    prune(directory, name)
  } catch {
    // Unwritten, this runtime's owners name no cause when they die.
  }
}

/**
 * The one "this Orca runtime is ending" entry point, for every graceful exit. Synchronous, so an
 * exit that cannot await still records it; the first call wins. Never throws.
 */
export function recordAgentSessionRuntimeEnd(
  trigger: AgentSessionResumeTrigger,
  now = Date.now()
): void {
  if (!current || current.record.end) {
    return
  }
  current.record = { ...current.record, end: { trigger, at: now } }
  try {
    writeRecord(current.path, current.record)
  } catch {
    // The start alone would read as a crash; with no record its owners name no cause.
    try {
      rmSync(current.path, { force: true })
    } catch {
      // Nothing left to try: the start stays, and reads as a crash.
    }
  }
}

function readTrigger(value: unknown): AgentSessionResumeTrigger | undefined {
  return AGENT_SESSION_RESUME_TRIGGERS.find((trigger) => trigger === value)
}

/** How a recorded runtime ended: its quit or update, else a crash. Undefined when unreadable. */
function readRecordedEnd(path: string, runtime: string): AgentSessionOrcaStopCause | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readNodeFileSyncWithinLimit(path, MAX_RUNTIME_RECORD_BYTES).buffer.toString('utf8')
    )
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('runtime' in parsed) ||
      parsed.runtime !== runtime ||
      !('startedAt' in parsed) ||
      typeof parsed.startedAt !== 'number'
    ) {
      return undefined
    }
    if (!('end' in parsed) || parsed.end === undefined) {
      return 'crash'
    }
    const end = parsed.end
    return readTrigger(
      typeof end === 'object' && end !== null && 'trigger' in end ? end.trigger : undefined
    )
  } catch {
    return undefined
  }
}

/**
 * How each recorded runtime ended. A runtime missing from the map (never recorded, pruned, or
 * unreadable) names no cause. Null when the records cannot be listed at all.
 */
export function readAgentSessionRuntimeEnds(
  stateDirectory: string
): ReadonlyMap<string, AgentSessionOrcaStopCause> | null {
  const directory = join(stateDirectory, RUNTIMES_DIRECTORY)
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? new Map() : null
  }
  const ends = new Map<string, AgentSessionOrcaStopCause>()
  for (const name of names) {
    const runtime = RECORD_FILE.exec(name)?.[1]
    const end = runtime ? readRecordedEnd(join(directory, name), runtime) : undefined
    if (runtime && end) {
      ends.set(runtime, end)
    }
  }
  return ends
}
