import { open, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { AgentType } from '../../../shared/agent-status-types'
import {
  decodeClaudeTurnLifecycle,
  decodeCodexTurnLifecycle,
  decodePiTurnLifecycle,
  type NativeChatTurnLifecycleDecoder
} from '../transcript-turn-lifecycle'
import type {
  SwitchStoppedCliTurn,
  SwitchTranscriptSource
} from './structured-agent-session-switch-import'

const BOUNDARY_WAIT_MS = 5_000
const BOUNDARY_POLL_MS = 100
const BOUNDARY_READ_BYTES = 4 * 1024 * 1024

// Agents that append their turn's end to the transcript Orca tails. Grok records it in a sidecar
// and OpenCode in a database; their one Escape does not end the turn either, so they skip the
// wait and the resting import settles the turn, as the wait's own timeout would.
const BOUNDARY_DECODERS: Partial<Record<AgentType, NativeChatTurnLifecycleDecoder>> = {
  codex: decodeCodexTurnLifecycle,
  claude: (line, fallbackId) => decodeClaudeTurnLifecycle(line, fallbackId, true),
  pi: decodePiTurnLifecycle
}

/**
 * After the switch's Escape, give the agent a short while to record its own end of the stopped
 * turn before the process is stopped (the common pattern: interrupt, await that turn's settle,
 * bounded, then stop anyway). Reads only what the agent appends after the Escape; one agent writes
 * the file in order, so the first end recorded there is the stopped turn's (Codex names it).
 * Arm before the Escape; the returned wait never throws: a read failure, a vanished file, the
 * abort or the bound all return, and the stop proceeds as it would have.
 */
export async function armSwitchTurnBoundaryWait(
  source: SwitchTranscriptSource,
  stopped: SwitchStoppedCliTurn,
  signal: AbortSignal,
  remainingMs: () => number
): Promise<() => Promise<void>> {
  const decode = BOUNDARY_DECODERS[source.agent]
  let offset: number
  try {
    offset = decode ? (await stat(source.filePath)).size : -1
  } catch {
    offset = -1
  }
  if (!decode || offset < 0) {
    return async () => {}
  }
  return async () => {
    const until = Date.now() + Math.min(BOUNDARY_WAIT_MS, Math.max(0, remainingMs() - 1_000))
    const text = new StringDecoder('utf8')
    let pending = ''
    try {
      while (!signal.aborted && Date.now() < until) {
        const size = (await stat(source.filePath)).size
        if (size > offset) {
          const length = Math.min(size - offset, BOUNDARY_READ_BYTES)
          const chunk = Buffer.alloc(length)
          const file = await open(source.filePath, 'r')
          try {
            await file.read(chunk, 0, length, offset)
          } finally {
            await file.close()
          }
          offset += length
          const lines = (pending + text.write(chunk)).split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines) {
            const ended = decode(line, '')
            if (
              ended &&
              ended.state !== 'working' &&
              (source.agent !== 'codex' || ended.turnId === stopped.turnId)
            ) {
              return
            }
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, BOUNDARY_POLL_MS)
          function done() {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve()
          }
          signal.addEventListener('abort', done, { once: true })
        })
      }
    } catch {
      // The proven stop and the resting import own correctness; this wait only adds fidelity.
    }
  }
}
