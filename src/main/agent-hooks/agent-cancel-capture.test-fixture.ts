// Loads the agent-CLI cancel captures (src/shared/__fixtures__/claude-cancel-*-hooks.jsonl and
// grok-cancel-*-hooks.jsonl, sidecars beside them): hook payloads recorded over a real PTY,
// merged in time order with the driver's cancel and kill markers.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_INTERRUPT_SETTLE_MS } from '../../shared/agent-interrupt-intent'

export type CapturedHook = {
  kind: 'hook'
  t: number
  index: number
  /** `ps` rows for the rig's sleep processes, taken inside the hook. */
  sleep_procs: string[]
  payload: Record<string, unknown>
}
export type CapturedCancel = {
  kind: 'cancel'
  t: number
  label: string
  interrupted_painted: boolean
  /** Hook indices between the cancel key and the next prompt the driver typed. */
  hooks_before_next_typed_prompt: number[]
}
export type CapturedKill = { kind: 'kill'; t: number; needle: string }
export type CapturedRecord = CapturedHook | CapturedCancel | CapturedKill

export function loadCapture(name: string): CapturedRecord[] {
  return readFileSync(
    join(__dirname, '..', '..', 'shared', '__fixtures__', `${name}.jsonl`),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => {
      // JSON.parse returns any; the kind check below is what proves the record shape.
      const parsed: CapturedRecord = JSON.parse(line)
      if (parsed.kind !== 'hook' && parsed.kind !== 'cancel' && parsed.kind !== 'kill') {
        throw new Error(`Unknown capture record: ${line}`)
      }
      return parsed
    })
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

/** Whether a hook landed inside the settle window on the capture's own clock, which is when the
 *  renderer's baseline check drops the inference instead of sending it. */
export function hookSupersedesCancel(records: CapturedRecord[], cancel: CapturedCancel): boolean {
  return records.some(
    (record) =>
      record.kind === 'hook' &&
      record.t > cancel.t &&
      (record.t - cancel.t) * 1000 < AGENT_INTERRUPT_SETTLE_MS
  )
}
