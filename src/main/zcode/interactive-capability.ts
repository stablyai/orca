import { runProcess } from '@orca/process-host'
import {
  isZCodeInteractiveTuiOutput,
  isZCodeMissingTuiOutput,
  type ZCodeInteractiveCapability
} from '../../shared/zcode-missing-tui'
import type { ZcodeCliInvocation } from './zcode-cli-invocation'

export type { ZCodeInteractiveCapability }

const PROBE_TIMEOUT_MS = 6_000

const cached = new Map<string, ZCodeInteractiveCapability>()
const inFlight = new Map<string, Promise<ZCodeInteractiveCapability>>()

export function _resetZCodeInteractiveCapabilityForTests(): void {
  cached.clear()
  inFlight.clear()
}

async function probe(invocation: ZcodeCliInvocation): Promise<ZCodeInteractiveCapability> {
  try {
    const result = await runProcess({
      program: invocation.command,
      args: [...invocation.prefixArgs, 'tui'],
      env: { ...process.env, ...invocation.envOverlay },
      input: '',
      timeoutMs: PROBE_TIMEOUT_MS
    })
    const output = `${result.stderr}\n${result.stdout}`
    if (isZCodeMissingTuiOutput(output)) {
      return 'missing-tui'
    }
    return result.timedOut || result.code === 0 || isZCodeInteractiveTuiOutput(output)
      ? 'interactive'
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Cache definitive capability per resolved installation; transient unknown verdicts may retry. */
export function readZCodeInteractiveCapability(
  invocation: ZcodeCliInvocation
): Promise<ZCodeInteractiveCapability> {
  const remembered = cached.get(invocation.identity)
  if (remembered !== undefined) {
    return Promise.resolve(remembered)
  }
  const pending = inFlight.get(invocation.identity)
  if (pending) {
    return pending
  }
  const next = probe(invocation).then((verdict) => {
    if (verdict !== 'unknown') {
      cached.set(invocation.identity, verdict)
    }
    inFlight.delete(invocation.identity)
    return verdict
  })
  inFlight.set(invocation.identity, next)
  return next
}
