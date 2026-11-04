import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { AgentSessionIdleConfirmation } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  PI_BACKGROUND_WORK_REQUEST_SUFFIX,
  PI_BACKGROUND_WORK_STATUS_KEY
} from './rpc-background-work-bridge-source'

const PROBE_TIMEOUT_MS = 5_000

/** Asks this child's bridge, at eviction time, whether a registered provider still owns work. */
export class PiRpcBackgroundWork {
  /** The bridge instance that announced readiness and has not shut down. */
  private instance: string | null = null
  private probe: { nonce: string; settle: (answer: AgentSessionIdleConfirmation) => void } | null =
    null
  private outstanding: Promise<AgentSessionIdleConfirmation> | null = null

  /** A null folder means Orca launched this child without the bridge: unprotected, as before. */
  constructor(private readonly directory: string | null) {}

  /** Consumes the bridge's status frames before decoration is dropped; false for every other frame. */
  receive(frame: JsonlRpcRecord): boolean {
    if (frame.method !== 'setStatus' || frame.statusKey !== PI_BACKGROUND_WORK_STATUS_KEY) {
      return false
    }
    const [kind, instance, nonce, state] =
      typeof frame.statusText === 'string' ? frame.statusText.split(':') : []
    if (kind === 'ready' && instance) {
      this.instance = instance
    } else if (kind === 'gone') {
      this.instance = null
    } else if (kind === 'answer' && instance === this.instance && nonce === this.probe?.nonce) {
      this.probe.settle(state === 'idle' ? 'idle' : state === 'active' ? 'busy' : 'unknown')
    }
    return true
  }

  /** Only a fresh answer from the current instance proves idleness; silence never does. */
  confirmIdle(): Promise<AgentSessionIdleConfirmation> {
    if (!this.directory) {
      return Promise.resolve('idle')
    }
    if (!this.instance) {
      return Promise.resolve('unknown')
    }
    this.outstanding ??= this.ask(this.directory, this.instance).finally(() => {
      this.outstanding = null
    })
    return this.outstanding
  }

  end(): void {
    this.instance = null
    this.probe?.settle('unknown')
    if (this.directory) {
      void rm(this.directory, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async ask(directory: string, instance: string): Promise<AgentSessionIdleConfirmation> {
    const nonce = randomUUID()
    const request = join(directory, `${instance}.${nonce}${PI_BACKGROUND_WORK_REQUEST_SUFFIX}`)
    const answered = new Promise<AgentSessionIdleConfirmation>((resolve) => {
      const timer = setTimeout(() => this.probe?.settle('unknown'), PROBE_TIMEOUT_MS)
      timer.unref?.()
      this.probe = {
        nonce,
        settle: (answer) => {
          clearTimeout(timer)
          this.probe = null
          resolve(answer)
        }
      }
    })
    try {
      // The bridge only reads complete requests, so stage under another suffix and rename.
      const staged = `${request}.${randomUUID()}.tmp`
      await writeFile(staged, '')
      await rename(staged, request)
    } catch {
      this.probe?.settle('unknown')
    }
    const answer = await answered
    await rm(request, { force: true }).catch(() => {})
    return answer
  }
}
