// Replays the captured Claude background-task stories (src/shared/__fixtures__/
// claude-background-{shell,workflow}-*-hooks.jsonl) through the server's own HTTP ingress, with each
// hook's `transcript_path` pointed at a temp file. The only record of a task ending with no hook is
// the `queue-operation` line Claude appends to its transcript; a story appends the captured line
// where it was written and lets the listener's transcript watch find it on a real tick.
// Callers mock telemetry and fake only `Date`, and call `cleanUpCaptureReplays` after each test.
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import {
  hookAt,
  type CapturedRecord,
  type CapturedTranscriptScan
} from './claude-cancel-capture.test-fixture'

const temporaryPaths: string[] = []
const running: AgentHookServer[] = []

export function cleanUpCaptureReplays(): void {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
}

export function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-background-task-'))
  temporaryPaths.push(dir)
  return dir
}

export function transcriptFile(): string {
  const path = join(temporaryDir(), 'session.jsonl')
  writeFileSync(path, '')
  return path
}

export async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  running.push(server)
  await server.start({ env: 'production' })
  return server
}

export function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

/** The background-task fact the stored row carries (`claudeRunningNonAgentTask`). */
export function storedTaskFact(server: AgentHookServer): boolean | undefined {
  return server._getStateForTests().lastStatusByPaneKey.get(PANE)?.claudeRunningNonAgentTask
}

export function watch(server: AgentHookServer) {
  return server._getStateForTests().claudeTranscriptCursorByPaneKey.get(PANE)
}

/** The renderer's part: capture the row as the baseline and, once the settle window passes with
 *  no hook, ask the server to infer from the Ctrl+C. */
export function pressCtrlC(server: AgentHookServer): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'claude',
    intent: 'ctrl-c'
  })
}

export function queueLine(records: CapturedRecord[], label: string): CapturedTranscriptScan {
  const scan = records.find((record) => record.kind === 'transcript' && record.label === label)
  if (scan?.kind !== 'transcript' || scan.lines.length !== 1) {
    throw new Error(`Captured transcript line ${label} not found`)
  }
  return scan
}

/** The capture's t=0 on the wall clock, from the stamp Claude wrote on its enqueue line. */
export function captureEpoch(records: CapturedRecord[]): number {
  const scan = queueLine(records, 'queue-operation-enqueue')
  // JSON.parse returns any; the timestamp is checked by Date.parse.
  const parsed: Record<string, unknown> = JSON.parse(scan.lines[0])
  return Date.parse(String(parsed.timestamp)) - scan.t * 1000
}

/** Replays hooks on the capture's clock, pointing each session's transcript at a temp file. A
 *  capture with no enqueue line passes its own `t0`. */
export function replayer(
  server: AgentHookServer,
  records: CapturedRecord[],
  files: Map<string, string>,
  t0 = captureEpoch(records)
) {
  return async (indices: number[]) => {
    for (const index of indices) {
      const hook = hookAt(records, index)
      vi.setSystemTime(t0 + hook.t * 1000)
      const reported = String(hook.payload.transcript_path)
      const transcript = files.get(reported) ?? files.get('*')
      await expect(
        postHookEvent(server, buildBody({ ...hook.payload, transcript_path: transcript }))
      ).resolves.toMatchObject({ status: 204 })
    }
  }
}

/** Appends a captured transcript line at its captured instant. */
export function writeCaptured(
  records: CapturedRecord[],
  scan: CapturedTranscriptScan,
  path: string
): void {
  vi.setSystemTime(captureEpoch(records) + scan.t * 1000)
  appendFileSync(path, `${scan.lines[0]}\n`)
}

/** Waits for a tick to have read everything the transcript holds. */
export async function watchCaughtUp(server: AgentHookServer, transcript: string): Promise<void> {
  const size = statSync(transcript).size
  await vi.waitFor(() => expect(watch(server)?.offset).toBe(size), { timeout: 3_000 })
}
