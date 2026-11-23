// What this host knows about its hooks and their calls, in an owner-only file, so a restart still
// starts and settles every call it took. Tagged with the account, as the turn outbox is.
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  WEBHOOK_CALL_ID_PATTERN,
  WEBHOOK_CALL_STATES,
  WEBHOOK_HOOK_ID_PATTERN
} from '../../shared/connector-webhook-contract'
import { isMissingFileError } from '../runtime/rpc/server/pairing/device-registry-corruption'
import { NewerAgentHooks } from './webhook-host-newer-agent-hooks'

const LEDGER_FILE = 'webhook-host.json'
// Kept as long as the cloud keeps call rows.
export const WEBHOOK_LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const HookId = z.string().regex(WEBHOOK_HOOK_ID_PATTERN)
const Epoch = z.number().int().nonnegative()

// received: taken and acknowledged, not yet offered to the automation.
const LedgerCallState = z.enum(['received', ...WEBHOOK_CALL_STATES])
export type LedgerCallState = z.infer<typeof LedgerCallState>

const LedgerCall = z.object({
  callId: z.string().regex(WEBHOOK_CALL_ID_PATTERN),
  hookId: HookId,
  automationId: z.string().min(1),
  triggerId: z.string().min(1),
  occurredAt: z.number(),
  subject: z.string().optional(),
  epoch: Epoch,
  sample: z.literal(true).optional(),
  /** The hook's first call that wasn't a sample. */
  first: z.literal(true).optional(),
  /** A host-level hook's call, bound to the automation and rule it was routed to. */
  routed: z.literal(true).optional(),
  /** The id its run will have, bound before the cloud is asked to start it, so every ask names one run. */
  reservedRunId: z.string().optional(),
  /** The call's file, written once its run was cleared to start; it goes with the row. */
  file: z.string().optional(),
  state: LedgerCallState,
  runId: z.string().optional(),
  reason: z.string().optional(),
  /** waiting_capacity: when the run caps have room again. */
  retryAt: z.number().optional(),
  updatedAt: z.number()
})
export type LedgerCall = z.infer<typeof LedgerCall>

const LedgerHook = z.object({
  hookId: HookId,
  automationId: z.string().min(1),
  botId: z.string().min(1),
  /** The newest generation this host has seen; a delivery below it is refused. */
  epoch: Epoch,
  /** What the cloud last confirmed. */
  state: z.enum(['pending', 'live', 'paused']),
  /** A call that wasn't a sample has arrived. */
  called: z.literal(true).optional(),
  /** A pause, resume or delete the cloud hasn't confirmed; retried with its operationId until it does. */
  change: z
    .object({ state: z.enum(['live', 'paused', 'deleted']), operationId: z.string().min(1) })
    .optional()
})
export type LedgerHook = z.infer<typeof LedgerHook>

// A create that may have minted a hook before its automation was saved.
const LedgerIntent = z.object({
  operationId: z.string().min(1),
  automationId: z.string().min(1),
  botId: z.string().min(1),
  hookId: HookId.optional(),
  createdAt: z.number()
})
export type LedgerIntent = z.infer<typeof LedgerIntent>

const StoredLedger = z.object({
  account: z.string().min(1),
  hooks: z.array(LedgerHook),
  calls: z.array(LedgerCall),
  intents: z.array(LedgerIntent)
})
type StoredLedger = z.infer<typeof StoredLedger>

const emptyLedger = (account: string): StoredLedger => ({
  account,
  hooks: [],
  calls: [],
  intents: []
})

export class WebhookHostLedger {
  private stored: StoredLedger | null = null
  // The last write failed: memory holds what disk lacks, so the next save writes even if unchanged.
  private unsaved = false
  private readonly newerAgentHooks: NewerAgentHooks<LedgerHook>

  constructor(
    private readonly userDataPath: string,
    private readonly account: () => string | null,
    newerAgentBotIds: () => ReadonlySet<string>
  ) {
    this.newerAgentHooks = new NewerAgentHooks(userDataPath, newerAgentBotIds, LedgerHook)
  }

  private get path(): string {
    return join(this.userDataPath, LEDGER_FILE)
  }

  /** The signed-in account's ledger; another account's is dropped, since its cloud owns those calls. */
  private ledger(): StoredLedger | null {
    const account = this.account()
    if (!account) {
      return null
    }
    if (this.stored?.account !== account) {
      const loaded = this.read()
      const ledger = loaded?.account === account ? loaded : emptyLedger(account)
      ledger.hooks = this.newerAgentHooks.load(account, ledger.hooks)
      this.stored = ledger
    }
    return this.stored
  }

  /** Bots were written: a hook whose bot changed agents moves into the file older builds read, or out of it. */
  refile(): void {
    const ledger = this.ledger()
    if (ledger && this.newerAgentHooks.unfiled(ledger.hooks)) {
      this.write()
    }
  }

  private read(): StoredLedger | null {
    try {
      const parsed = StoredLedger.safeParse(JSON.parse(readFileSync(this.path, 'utf8')))
      return parsed.success ? parsed.data : null
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.warn('[webhooks] the host ledger was unreadable; starting a new one')
      }
      return null
    }
  }

  /** Other writes may trail a crash and are reconciled. */
  private write(): void {
    if (!this.stored) {
      return
    }
    try {
      this.newerAgentHooks.save(this.path, this.stored, false)
      this.unsaved = false
    } catch (error) {
      this.unsaved = true
      console.warn('[webhooks] could not write the host ledger', error)
    }
  }

  /** On disk before it is in memory, so a failed write leaves nothing a redelivery or replay could trust. */
  private commit(change: (ledger: StoredLedger) => void): boolean {
    const ledger = this.ledger()
    if (!ledger) {
      return false
    }
    const next = structuredClone(ledger)
    change(next)
    this.newerAgentHooks.save(this.path, next, true)
    this.stored = next
    return true
  }

  /** Drops the matching calls and deletes their files; one that won't go is left to the folder sweep. */
  private dropCalls(ledger: StoredLedger, drop: (call: LedgerCall) => boolean): void {
    const dropped = ledger.calls.filter(drop)
    if (dropped.length === 0) {
      return
    }
    ledger.calls = ledger.calls.filter((call) => !drop(call))
    for (const call of dropped) {
      if (call.file) {
        remove(call.file)
      }
    }
    this.write()
  }

  /** Every file a call row still owns. */
  files(): ReadonlySet<string> {
    return new Set(this.ledger()?.calls.flatMap((call) => (call.file ? [call.file] : [])) ?? [])
  }

  hooks(): readonly LedgerHook[] {
    return this.ledger()?.hooks ?? []
  }

  hook(hookId: string): LedgerHook | undefined {
    return this.hooks().find((entry) => entry.hookId === hookId)
  }

  /** Records the cloud's view of a hook; its generation only moves forward. */
  saveHook(hook: Omit<LedgerHook, 'called'>): void {
    const ledger = this.ledger()
    if (!ledger) {
      return
    }
    const known = ledger.hooks.find((entry) => entry.hookId === hook.hookId)
    const next: LedgerHook = {
      ...known,
      ...hook,
      epoch: Math.max(known?.epoch ?? 0, hook.epoch)
    }
    // Card reads say the same thing every time; only news is written.
    if (
      known &&
      !this.unsaved &&
      known.automationId === next.automationId &&
      known.botId === next.botId &&
      known.epoch === next.epoch &&
      known.state === next.state
    ) {
      return
    }
    ledger.hooks = [...ledger.hooks.filter((entry) => entry.hookId !== hook.hookId), next]
    this.write()
  }

  /** Forgets a hook, its calls and their files, and any create that minted it. */
  dropHook(hookId: string): void {
    const ledger = this.ledger()
    if (!ledger) {
      return
    }
    ledger.hooks = ledger.hooks.filter((entry) => entry.hookId !== hookId)
    ledger.intents = ledger.intents.filter((intent) => intent.hookId !== hookId)
    this.write()
    this.dropCalls(ledger, (call) => call.hookId === hookId)
  }

  /** Records a pause, resume or delete to send, or clears it once the cloud confirms. */
  setChange(hookId: string, change: LedgerHook['change']): void {
    this.commit((ledger) => {
      const hook = ledger.hooks.find((entry) => entry.hookId === hookId)
      if (hook) {
        hook.change = change
      }
    })
  }

  calls(): readonly LedgerCall[] {
    return this.ledger()?.calls ?? []
  }

  call(callId: string): LedgerCall | undefined {
    return this.calls().find((entry) => entry.callId === callId)
  }

  /** Takes a delivered call, durably; false when signed out, so it isn't acknowledged. */
  receive(call: Omit<LedgerCall, 'state' | 'updatedAt'>, now: number): boolean {
    return this.commit((ledger) => {
      ledger.calls.push({ ...call, state: 'received', updatedAt: now })
      for (const hook of ledger.hooks.filter((entry) => entry.hookId === call.hookId)) {
        hook.epoch = Math.max(hook.epoch, call.epoch)
        if (!call.sample) {
          hook.called = true
        }
      }
    })
  }

  /** Moves a call on. */
  update(
    callId: string,
    change: Pick<LedgerCall, 'state'> & Partial<Pick<LedgerCall, 'runId' | 'reason' | 'retryAt'>>,
    now: number
  ): LedgerCall | undefined {
    const call = this.ledger()?.calls.find((entry) => entry.callId === callId)
    if (!call) {
      return undefined
    }
    Object.assign(call, change, { updatedAt: now })
    if (change.state !== 'waiting_capacity') {
      delete call.retryAt
    }
    this.write()
    return call
  }

  /**
   * Durable: the run id before the start is asked, so a replay asks for and makes that same run; the
   * call's file, so it goes with the row; a routed call's destination, so it is chosen once.
   */
  bind(
    callId: string,
    binding:
      | Pick<LedgerCall, 'reservedRunId'>
      | Pick<LedgerCall, 'file'>
      | Required<Pick<LedgerCall, 'automationId' | 'triggerId' | 'routed'>>
  ): void {
    this.commit((ledger) => {
      Object.assign(ledger.calls.find((entry) => entry.callId === callId) ?? {}, binding)
    })
  }

  /** Durable before the run launches, so recovery finds the run by this, not by run history. */
  bindRun(callId: string, runId: string, now: number): void {
    this.commit((ledger) => {
      const call = ledger.calls.find((entry) => entry.callId === callId)
      if (call && call.runId !== runId) {
        Object.assign(call, { state: 'started', runId, updatedAt: now })
      }
    })
  }

  /** Drops settled calls past retention, with their files, and retries failed deletes. */
  prune(now: number, isSettled: (call: LedgerCall) => boolean): void {
    const ledger = this.ledger()
    if (!ledger) {
      return
    }
    this.dropCalls(
      ledger,
      (call) => now - call.occurredAt > WEBHOOK_LEDGER_RETENTION_MS && isSettled(call)
    )
  }

  intents(): readonly LedgerIntent[] {
    return this.ledger()?.intents ?? []
  }

  saveIntent(intent: LedgerIntent): void {
    this.commit((ledger) => {
      ledger.intents = [
        ...ledger.intents.filter((entry) => entry.operationId !== intent.operationId),
        intent
      ]
    })
  }

  dropIntent(operationId: string): void {
    const ledger = this.ledger()
    if (ledger) {
      ledger.intents = ledger.intents.filter((entry) => entry.operationId !== operationId)
      this.write()
    }
  }

  /** A call the cloud cancelled, with its file; it won't be delivered again. */
  forget(callId: string): void {
    const ledger = this.ledger()
    if (ledger) {
      this.dropCalls(ledger, (call) => call.callId === callId)
    }
  }
}

function remove(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch (error) {
    console.warn('[webhooks] could not delete a call file', error)
  }
}
