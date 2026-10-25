// One file per runtime avoids cross-process read/modify/write loss; record start plus graceful quit/update.
// Only a recorded start without end implies crash; missing/unreadable/pruned records leave cause unknown.

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
// Retain enough history to attribute owners from recent restarts.
const MAX_RUNTIME_RECORDS = 16
const MAX_RUNTIME_RECORD_BYTES = 4 * 1024
// Reap temp files left by writers dying before rename.
const STALE_TEMP_FILE_MS = 60_000
const RECORD_FILE = /^([A-Za-z0-9-]{1,64})\.json$/

type RuntimeRecord = {
  runtime: string
  startedAt: number
  end?: { trigger: AgentSessionResumeTrigger; at: number }
}

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

/** Record unhandled zero-code process exits as quit; nonzero exits retain crash classification. */
export function recordAgentSessionRuntimeEndOnExit(code: number): void {
  if (code === 0) {
    recordAgentSessionRuntimeEnd('quit')
  }
}

let exitHookInstalled = false

/** Record startup without throwing; repeated opens during quit must preserve the first ending. */
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

/** First graceful ending wins; synchronous/no-throw so nonawaiting exit paths can record it. */
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
    // If end persistence failed, remove the start so it cannot falsely imply crash.
    try {
      rmSync(current.path, { force: true })
    } catch {
      // Failed removal leaves only the start, so later readers infer crash.
    }
  }
}

function readTrigger(value: unknown): AgentSessionResumeTrigger | undefined {
  return AGENT_SESSION_RESUME_TRIGGERS.find((trigger) => trigger === value)
}

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

/** Missing/unreadable runtime records give no cause; null means the directory itself could not be listed. */
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
