// This host's own webhooks, for local webhooks: hooks, keys and calls in an owner-only file under
// userData, each call's envelope in its own file. It answers what Orca Cloud keeps for a hook.
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { WebhookEnvelope, type WebhookView } from '../../../shared/connector-webhook-routes'
import {
  type StoredLocalWebhooks,
  PENDING,
  counted,
  deliveryHash,
  historyRows,
  hookView,
  isPending,
  keyMatches,
  loadLocalWebhooks,
  newCallId,
  newHookId,
  newWebhookKey,
  pruneSettledCalls,
  queuedCalls,
  writeOwnerOnlyFile,
  type LocalCall,
  type LocalCounterKind,
  type LocalHook
} from './local-webhook-records'

export type { LocalCall, LocalHook } from './local-webhook-records'

const DIR = 'local-webhooks'
const FILE = 'hooks.json'
const ENVELOPES = 'envelopes'

const DAY_MS = 24 * 60 * 60 * 1000
// A rotated key keeps working this long unless the rotation stops it now.
const PREVIOUS_KEY_MS = DAY_MS
// A sender's delivery id is remembered this long, so its resend is dropped.
const REPLAY_MS = DAY_MS
// Pending calls (queued, or handed over and not started) are never pruned (pruneSettledCalls); past
// this many, no new one is taken.
const QUEUED_PER_HOOK = 50

export class LocalWebhookStore {
  private loaded: Promise<StoredLocalWebhooks> | null = null
  private turns: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly userDataPath: string,
    private readonly now: () => number = Date.now
  ) {}

  private get dir(): string {
    return join(this.userDataPath, DIR)
  }

  private envelopePath(callId: string): string {
    return join(this.dir, ENVELOPES, `${callId}.json`)
  }

  private data(): Promise<StoredLocalWebhooks> {
    // A failed read is not kept: the next access reads the file again.
    return (this.loaded ??= loadLocalWebhooks(join(this.dir, FILE)).catch((error: unknown) => {
      this.loaded = null
      throw error
    }))
  }

  /**
   * Every write runs here, one at a time: it finds what it changes by id in the current state, changes
   * it with no await, and is saved before the next one starts. A failed save drops memory, so the
   * next change starts from the file and nothing a caller was refused is kept or acknowledged.
   */
  private inTurn<T>(change: (data: StoredLocalWebhooks) => T): Promise<T> {
    const next = this.turns.then(async () => {
      const data = await this.data()
      const result = change(data)
      try {
        await writeOwnerOnlyFile(join(this.dir, FILE), JSON.stringify(data))
      } catch (error) {
        this.loaded = null
        throw error
      }
      return result
    })
    this.turns = next.catch(() => {})
    return next
  }

  async hooks(botId?: string): Promise<LocalHook[]> {
    return (await this.data()).hooks.filter((hook) => botId === undefined || hook.botId === botId)
  }

  async hook(hookId: string): Promise<LocalHook | undefined> {
    return (await this.data()).hooks.find((hook) => hook.hookId === hookId)
  }

  async call(callId: string): Promise<LocalCall | undefined> {
    return (await this.data()).calls.find((call) => call.callId === callId)
  }

  /** The hook a key opens; an unknown hook and a wrong key are the same null. */
  async authenticate(hookId: string, key: string): Promise<LocalHook | null> {
    const hook = await this.hook(hookId)
    // An unknown hook still compares once, so its answer takes as long as a wrong key's.
    const current = keyMatches(key, hook?.key ?? newWebhookKey())
    return hook && (current || this.previousKeyOpens(hook, key)) ? hook : null
  }

  private previousKeyOpens(hook: LocalHook, key: string): boolean {
    return (
      hook.previousKey !== undefined &&
      (hook.previousKeyExpiresAt ?? 0) > this.now() &&
      keyMatches(key, hook.previousKey)
    )
  }

  /** Whether a call with this sender delivery id was taken in the last day. */
  async deliveryTaken(hookId: string, deliveryId: string): Promise<boolean> {
    const id = deliveryHash(deliveryId)
    const since = this.now() - REPLAY_MS
    return (await this.data()).deliveries.some(
      (entry) => entry.hookId === hookId && entry.id === id && entry.at > since
    )
  }

  /** Calls taken but never handed to the host's webhooks, e.g. when that failed or Orca quit. */
  async queued(): Promise<{ hook: LocalHook; call: LocalCall }[]> {
    return queuedCalls(await this.data())
  }

  /** The hook a create made; a repeat with the same operationId gets the same hook. */
  mint(operationId: string, automationId: string, botId: string): Promise<LocalHook> {
    return this.inTurn((data) => {
      const made = data.hooks.find((hook) => hook.mintOperationId === operationId)
      if (made) {
        return made
      }
      const hook: LocalHook = {
        hookId: newHookId(),
        automationId,
        botId,
        state: 'live',
        epoch: 1,
        keyGeneration: 1,
        key: newWebhookKey(),
        previousKeyExpiresAt: null,
        mintOperationId: operationId,
        lastCall: null
      }
      data.hooks.push(hook)
      return hook
    })
  }

  /** A pause cancels the calls not yet started, as Orca Cloud does, and raises the hook's epoch. */
  async setState(hookId: string, state: LocalHook['state']): Promise<LocalHook | null> {
    const { hook, files } = await this.inTurn((data) => {
      const found = data.hooks.find((entry) => entry.hookId === hookId)
      if (!found || found.state === state) {
        return { hook: found ?? null, files: [] }
      }
      found.state = state
      if (state === 'paused') {
        found.epoch++
      }
      const ended = state === 'paused' ? this.cancelPending(data, hookId) : null
      return { hook: found, files: ended?.files ?? [] }
    })
    await this.removeEnvelopes(files)
    return hook
  }

  async remove(hookId: string): Promise<void> {
    const files = await this.inTurn((data) => {
      const gone = data.calls.filter((entry) => entry.hookId === hookId && entry.hasEnvelope)
      data.hooks = data.hooks.filter((hook) => hook.hookId !== hookId)
      data.calls = data.calls.filter((call) => call.hookId !== hookId)
      data.counters = data.counters.filter((counter) => counter.hookId !== hookId)
      data.deliveries = data.deliveries.filter((entry) => entry.hookId !== hookId)
      return gone
    })
    await this.removeEnvelopes(files)
  }

  /** A new key; the old one keeps working a day, or stops now with the calls it let in. Null for a
   *  hook that is gone. */
  async rotate(hookId: string, operationId: string, stopNow: boolean): Promise<number | null> {
    const { cancelled, files } = await this.inTurn((data) => {
      const hook = data.hooks.find((entry) => entry.hookId === hookId)
      if (!hook || hook.rotateOperationId === operationId) {
        return { cancelled: hook ? (hook.rotateCancelled ?? 0) : null, files: [] }
      }
      hook.rotateOperationId = operationId
      if (stopNow) {
        delete hook.previousKey
      } else {
        hook.previousKey = hook.key
      }
      hook.previousKeyExpiresAt = stopNow ? null : this.now() + PREVIOUS_KEY_MS
      hook.key = newWebhookKey()
      hook.keyGeneration++
      const ended = stopNow ? this.cancelPending(data, hookId) : { count: 0, files: [] }
      hook.rotateCancelled = ended.count
      return { cancelled: ended.count, files: ended.files }
    })
    await this.removeEnvelopes(files)
    return cancelled
  }

  /** Marks the calls not yet started cancelled, with no envelope; their files go after the save. */
  private cancelPending(
    data: StoredLocalWebhooks,
    hookId: string
  ): { count: number; files: LocalCall[] } {
    const pending = data.calls.filter((call) => call.hookId === hookId && isPending(call))
    const files = pending.filter((call) => call.hasEnvelope)
    for (const call of pending) {
      call.state = 'cancelled'
      call.hasEnvelope = false
    }
    return { count: pending.length, files }
  }

  /** Best effort, after a save: a leftover file is never read once no call lists it. */
  private async removeEnvelopes(calls: readonly LocalCall[]): Promise<void> {
    await Promise.all(
      calls.map((call) => rm(this.envelopePath(call.callId), { force: true }).catch(() => {}))
    )
  }

  /** A refused, over-budget or duplicate request, counted per minute as the call history shows them. */
  async count(hookId: string, kind: LocalCounterKind): Promise<void> {
    await this.inTurn((data) => {
      data.counters = counted(data.counters, hookId, kind, this.now())
    })
  }

  /** A new call with its envelope (none if ignored or paused); settled calls past the caps go. Stores
   *  nothing for null (hook gone, or the sender's key ended since checked) or 'queue_full'. */
  async admit(
    hook: LocalHook,
    call: Omit<LocalCall, 'callId' | 'hookId' | 'hasEnvelope' | 'epoch'>,
    envelope: WebhookEnvelope | null,
    sender: { key?: string; deliveryId?: string } = {}
  ): Promise<LocalCall | 'queue_full' | null> {
    const entry: LocalCall = {
      ...call,
      callId: newCallId(),
      hookId: hook.hookId,
      // As the call came in; a pause since then refuses it at handoff.
      epoch: hook.epoch,
      hasEnvelope: envelope !== null
    }
    if (envelope) {
      await writeOwnerOnlyFile(this.envelopePath(entry.callId), JSON.stringify(envelope))
    }
    const taken = await this.inTurn((data) => {
      const current = data.hooks.find((other) => other.hookId === hook.hookId)
      const { key, deliveryId } = sender
      const keyEnded =
        key !== undefined &&
        current &&
        !keyMatches(key, current.key) &&
        !this.previousKeyOpens(current, key)
      if (!current || keyEnded) {
        return null
      }
      const pending = data.calls.filter((entry) => entry.hookId === hook.hookId && isPending(entry))
      if (call.state === 'queued' && pending.length >= QUEUED_PER_HOOK) {
        return 'queue_full'
      }
      data.calls.unshift(entry)
      if (deliveryId !== undefined) {
        // Saved with the call itself, so a resend is a duplicate exactly when its call was taken.
        const at = call.receivedAt
        data.deliveries = data.deliveries.filter((other) => other.at > at - REPLAY_MS)
        data.deliveries.push({ hookId: hook.hookId, id: deliveryHash(deliveryId), at })
      }
      current.lastCall = { at: call.receivedAt, state: call.state, callId: entry.callId }
      return pruneSettledCalls(data, hook.hookId)
    }).catch(async (error: unknown) => {
      await this.removeEnvelopes([entry])
      throw error
    })
    // A refused call's own envelope, or old ones pushed out: only after the save.
    await this.removeEnvelopes(Array.isArray(taken) ? taken : [entry])
    return Array.isArray(taken) ? entry : taken
  }

  /**
   * Hands a still-queued call to `take` inside the write queue, so no cancellation lands between the
   * check and the handoff; the call is then delivered, or refused when `take` declines it.
   */
  async handOverQueued(
    callId: string,
    take: (hook: LocalHook, call: LocalCall) => boolean
  ): Promise<void> {
    await this.inTurn((data) => {
      const call = data.calls.find((entry) => entry.callId === callId)
      const hook = data.hooks.find((entry) => entry.hookId === call?.hookId)
      if (!call || call.state !== 'queued') {
        return
      }
      const taken = hook !== undefined && take(hook, call)
      call.state = taken ? 'delivered' : 'refused'
      if (!taken) {
        call.reason = 'automation_not_listening'
      }
      if (hook?.lastCall?.callId === call.callId) {
        hook.lastCall.state = call.state
      }
    })
  }

  /** The run start a call gets: once, for one run. */
  start(callId: string, runId: string): Promise<'started' | 'another_run' | 'settled'> {
    return this.inTurn((data) => {
      const call = data.calls.find((entry) => entry.callId === callId)
      if (call?.runId !== undefined) {
        return call.runId === runId ? 'started' : 'another_run'
      }
      if (!call || !PENDING.includes(call.state)) {
        return 'settled'
      }
      call.runId = runId
      call.state = 'started'
      return 'started'
    })
  }

  async envelope(callId: string): Promise<WebhookEnvelope | null> {
    const call = await this.call(callId)
    if (!call?.hasEnvelope) {
      return null
    }
    try {
      return WebhookEnvelope.parse(JSON.parse(await readFile(this.envelopePath(callId), 'utf8')))
    } catch {
      return null
    }
  }

  /** The hook's calls and counted requests, newest first. */
  async history(hookId: string): Promise<ReturnType<typeof historyRows>> {
    const data = await this.data()
    const own = <T extends { hookId: string }>(rows: T[]) =>
      rows.filter((row) => row.hookId === hookId)
    return historyRows(own(data.calls), own(data.counters))
  }

  async view(hook: LocalHook, baseUrl: string): Promise<WebhookView> {
    const { calls } = await this.data()
    const pending = calls.filter((c) => c.hookId === hook.hookId && isPending(c)).length
    return hookView(hook, pending, baseUrl, this.now())
  }

  /** The sample call a Send sample made; a repeat with the same operationId gets the same call. */
  async sampleCall(operationId: string): Promise<LocalCall | undefined> {
    return (await this.data()).calls.find((call) => call.sampleOperationId === operationId)
  }
}
