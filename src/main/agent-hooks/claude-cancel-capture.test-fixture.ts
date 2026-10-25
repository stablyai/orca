// Merge Claude Code 2.1.280 PTY hook captures with their cancel/kill sidecars in time order.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { AGENT_INTERRUPT_SETTLE_MS } from '../../shared/agent-interrupt-intent'

const capturedHook = z.object({
  kind: z.literal('hook'),
  t: z.number(),
  index: z.number().int().nonnegative(),
  sleep_procs: z.array(z.string()),
  payload: z.record(z.string(), z.unknown())
})
const capturedCancel = z.object({
  kind: z.literal('cancel'),
  t: z.number(),
  label: z.string(),
  interrupted_painted: z.boolean(),
  hooks_before_next_typed_prompt: z.array(z.number().int().nonnegative())
})
const capturedKill = z.object({ kind: z.literal('kill'), t: z.number(), needle: z.string() })
const capturedRecord = z.discriminatedUnion('kind', [capturedHook, capturedCancel, capturedKill])

export type CapturedHook = z.infer<typeof capturedHook>
export type CapturedCancel = z.infer<typeof capturedCancel>
export type CapturedKill = z.infer<typeof capturedKill>
export type CapturedRecord = z.infer<typeof capturedRecord>

export function loadCapture(name: string): CapturedRecord[] {
  return readFileSync(
    join(__dirname, '..', '..', 'shared', '__fixtures__', `${name}.jsonl`),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => capturedRecord.parse(JSON.parse(line)))
}

export function hookAt(records: CapturedRecord[], index: number): CapturedHook {
  const hook = records.find((record) => record.kind === 'hook' && record.index === index)
  if (hook?.kind !== 'hook') {
    throw new Error(`Captured hook ${index} not found`)
  }
  return hook
}

export function cancelLabelled(records: CapturedRecord[], label: string): CapturedCancel {
  const cancel = records.find((record) => record.kind === 'cancel' && record.label === label)
  if (cancel?.kind !== 'cancel') {
    throw new Error(`Captured cancel ${label} not found`)
  }
  return cancel
}

/** A hook inside the capture's settle window supersedes the renderer's inferred cancellation. */
export function hookSupersedesCancel(records: CapturedRecord[], cancel: CapturedCancel): boolean {
  return records.some(
    (record) =>
      record.kind === 'hook' &&
      record.t > cancel.t &&
      (record.t - cancel.t) * 1000 < AGENT_INTERRUPT_SETTLE_MS
  )
}
