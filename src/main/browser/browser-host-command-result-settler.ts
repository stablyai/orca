import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'

// Preserve half of the subscription's 32 nested-request slots for future control traffic.
const DEFAULT_MAX_CONCURRENT_COMMAND_RESULTS = 16
// Mirror the server ledger ceiling so an honest host never over-admits completed work.
const DEFAULT_MAX_UNSETTLED_COMMAND_RESULTS = 256

export type BrowserHostCommandResultAdmission = { active: boolean; commandKey: string }

export type BrowserHostCommandResultAdmissionResult = {
  admission: BrowserHostCommandResultAdmission
  duplicate: boolean
}

type PendingCommandResult = {
  admission: BrowserHostCommandResultAdmission
  command: BrowserClientHostCommandEvent
  result: BrowserClientHostCommandResult
  rejectReady: (error: Error) => void
}

type BrowserHostCommandResultSettlerOptions = {
  maxConcurrent?: number
  maxUnsettled?: number
  submit: (
    command: BrowserClientHostCommandEvent,
    result: BrowserClientHostCommandResult
  ) => Promise<void>
  onError: (error: Error, rejectReady: (error: Error) => void) => void
}

export class BrowserHostCommandResultSettler {
  private readonly maxConcurrent: number
  private readonly maxUnsettled: number
  private readonly pending: PendingCommandResult[] = []
  private readonly admissionsByCommandKey = new Map<string, BrowserHostCommandResultAdmission>()
  private unsettled = 0
  private inFlight = 0
  private closed = false

  constructor(private readonly options: BrowserHostCommandResultSettlerOptions) {
    this.maxConcurrent = boundedLimit(options.maxConcurrent, DEFAULT_MAX_CONCURRENT_COMMAND_RESULTS)
    this.maxUnsettled = boundedLimit(options.maxUnsettled, DEFAULT_MAX_UNSETTLED_COMMAND_RESULTS)
    if (this.maxConcurrent > this.maxUnsettled) {
      throw new Error('Browser host command result limits are inconsistent')
    }
  }

  admit(command: BrowserClientHostCommandEvent): BrowserHostCommandResultAdmissionResult | null {
    const commandKey = browserHostCommandResultAdmissionKey(command)
    const existing = this.admissionsByCommandKey.get(commandKey)
    if (existing?.active) {
      return { admission: existing, duplicate: true }
    }
    if (this.closed || this.unsettled >= this.maxUnsettled) {
      return null
    }
    this.unsettled += 1
    const admission = { active: true, commandKey }
    this.admissionsByCommandKey.set(commandKey, admission)
    return { admission, duplicate: false }
  }

  enqueue(
    admission: BrowserHostCommandResultAdmission,
    command: BrowserClientHostCommandEvent,
    result: BrowserClientHostCommandResult,
    rejectReady: (error: Error) => void
  ): void {
    if (this.closed) {
      this.release(admission)
      return
    }
    this.pending.push({ admission, command, result, rejectReady })
    this.drain()
  }

  release(admission: BrowserHostCommandResultAdmission): void {
    if (!admission.active) {
      return
    }
    admission.active = false
    if (this.admissionsByCommandKey.get(admission.commandKey) === admission) {
      this.admissionsByCommandKey.delete(admission.commandKey)
    }
    this.unsettled -= 1
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const pending of this.pending) {
      this.release(pending.admission)
    }
    this.pending.length = 0
    this.admissionsByCommandKey.clear()
  }

  private drain(): void {
    while (!this.closed && this.inFlight < this.maxConcurrent && this.pending.length > 0) {
      const pending = this.pending.shift()
      if (!pending) {
        return
      }
      this.inFlight += 1
      void Promise.resolve()
        .then(() => this.options.submit(pending.command, pending.result))
        .catch((error) =>
          this.options.onError(
            error instanceof Error ? error : new Error(String(error)),
            pending.rejectReady
          )
        )
        .finally(() => {
          this.inFlight -= 1
          this.release(pending.admission)
          this.drain()
        })
    }
  }
}

function browserHostCommandResultAdmissionKey(command: BrowserClientHostCommandEvent): string {
  return JSON.stringify([
    command.browserPageId,
    command.pageHostGeneration,
    command.commandSequence,
    command.commandId
  ])
}

function boundedLimit(value: number | undefined, maximum: number): number {
  const resolved = value ?? maximum
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error('Browser host command result limit is invalid')
  }
  return resolved
}
