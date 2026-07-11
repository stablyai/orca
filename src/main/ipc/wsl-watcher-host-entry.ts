import { posix } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Readable } from 'node:stream'
import {
  createWatcherBindingWatchdog,
  type WatcherBindingWatchdog
} from './wsl-watcher-host-binding-watchdog'
import { startWslWatcherCanary } from './wsl-watcher-host-canary'
import {
  createBoundedProtocolWriter,
  scanWatcherSafetySnapshot,
  type WatcherHostOutput
} from './wsl-watcher-host-safety'
import {
  createWatcherHostResourceBudget,
  createWatcherReconciliation,
  releaseWatcherReconciliationResources,
  replaceWatcherSafetySnapshot,
  type WatcherHostResourceBudget,
  type WatcherReconciliationState,
  type WatcherSafetyScanner
} from './wsl-watcher-host-reconciliation'

type WatcherEvent = { type: 'create' | 'update' | 'delete'; path: string }

type NativeWatcherOptions = {
  ignoreGlobs?: string[]
}

type NativeWatcherBinding = {
  subscribe(
    dir: string,
    callback: (error: Error | null, events: WatcherEvent[]) => void,
    options: NativeWatcherOptions
  ): Promise<void>
  unsubscribe(
    dir: string,
    callback: (error: Error | null, events: WatcherEvent[]) => void,
    options: NativeWatcherOptions
  ): Promise<void>
}

type HostCommand =
  | { op: 'subscribe'; id: number; dir: string; ignoreDirs: string[] }
  | { op: 'unsubscribe'; id: number }

type Subscription = WatcherReconciliationState & {
  callback: (error: Error | null, events: WatcherEvent[]) => void
  options: NativeWatcherOptions
  ready: Promise<void>
  attached: boolean
}

const NATIVE_BINDING_TIMEOUT_MS = 30_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildIgnoreGlobs(ignoreDirs: readonly string[]): string[] {
  return ignoreDirs.map((dir) => `^(?:.*/)?${escapeRegex(dir)}(?:/.*)?$`)
}

function parseCommand(line: string): HostCommand | null {
  try {
    const command = JSON.parse(line) as Partial<HostCommand>
    if (!Number.isSafeInteger(command.id) || (command.id ?? 0) <= 0) {
      return null
    }
    if (command.op === 'unsubscribe') {
      return { op: 'unsubscribe', id: command.id! }
    }
    if (
      command.op === 'subscribe' &&
      typeof command.dir === 'string' &&
      command.dir.startsWith('/') &&
      Array.isArray(command.ignoreDirs) &&
      command.ignoreDirs.every((dir) => typeof dir === 'string')
    ) {
      return {
        op: 'subscribe',
        id: command.id!,
        dir: command.dir,
        ignoreDirs: command.ignoreDirs
      }
    }
  } catch {
    return null
  }
  return null
}

export function startWslWatcherHost(
  binding: NativeWatcherBinding,
  input: Readable,
  output: WatcherHostOutput,
  exit: (code: number) => void = process.exit,
  scanSafety: WatcherSafetyScanner = scanWatcherSafetySnapshot,
  resourceBudget: WatcherHostResourceBudget = createWatcherHostResourceBudget(),
  bindingTimeoutMs = NATIVE_BINDING_TIMEOUT_MS
): { close(): Promise<void>; bindingWatchdog: WatcherBindingWatchdog } {
  const subscriptions = new Map<number, Subscription>()
  const send = createBoundedProtocolWriter(output, exit)
  const bindingWatchdog = createWatcherBindingWatchdog(exit, bindingTimeoutMs)

  const interrupt = (subscription: Subscription, message: string, reason?: 'topology'): void => {
    if (subscription.interrupted) {
      return
    }
    subscription.interrupted = true
    if (subscription.reconcileTimer) {
      clearTimeout(subscription.reconcileTimer)
      subscription.reconcileTimer = null
    }
    subscription.abortController.abort()
    send({
      op: 'watch-error',
      id: subscription.id,
      message,
      ...(reason ? { reason } : {})
    })
  }

  const reconciliation = createWatcherReconciliation<Subscription>({
    isCurrent: (state) => subscriptions.get(state.id) === state,
    interrupt,
    emitEvents: (state, events) => send({ op: 'events', id: state.id, events }),
    scan: scanSafety
  })

  const subscribe = (command: Extract<HostCommand, { op: 'subscribe' }>): void => {
    if (subscriptions.has(command.id)) {
      send({ op: 'subscribe-failed', id: command.id, message: 'duplicate subscription id' })
      return
    }
    const dir = posix.resolve(command.dir)
    const options = { ignoreGlobs: buildIgnoreGlobs(command.ignoreDirs) }
    let subscription: Subscription
    const callback = (error: Error | null, events: WatcherEvent[]): void => {
      if (error) {
        interrupt(subscription, errorMessage(error))
      } else if (events.length > 0) {
        reconciliation.recordNativeEvents(subscription, events)
      }
    }
    subscription = {
      id: command.id,
      dir,
      callback,
      options,
      ready: Promise.resolve(),
      ignoreDirs: new Set(command.ignoreDirs),
      safetySnapshot: new Map(),
      reconcileTimer: null,
      interrupted: false,
      abortController: new AbortController(),
      attached: false,
      scanEvents: null,
      scanEventsOverflowed: false,
      nativeEventCount: 0,
      idleRounds: 0,
      operationTail: Promise.resolve(),
      pendingNativeEvents: 0,
      resourceBudget,
      reservedSnapshotEntries: 0,
      reservedJournalEvents: 0,
      reservedPendingEvents: 0
    }
    subscriptions.set(command.id, subscription)
    subscription.ready = (async () => {
      try {
        const before = await scanSafety(dir, subscription.ignoreDirs, {
          signal: subscription.abortController.signal
        })
        if (before.kind !== 'complete') {
          throw new Error(`Initial watcher checkpoint ${before.kind}`)
        }
        if (
          subscription.abortController.signal.aborted ||
          subscriptions.get(command.id) !== subscription
        ) {
          return
        }
        if (!replaceWatcherSafetySnapshot(subscription, before.snapshot)) {
          interrupt(subscription, 'recursive watch snapshot resource-limit', 'topology')
          return
        }
        subscription.scanEvents = []
        await bindingWatchdog.watch('subscribe', binding.subscribe(dir, callback, options))
        subscription.attached = true
        if (
          subscription.abortController.signal.aborted ||
          subscriptions.get(command.id) !== subscription
        ) {
          return
        }
        if (!(await reconciliation.checkpoint(subscription)) || subscription.interrupted) {
          return
        }
        send({ op: 'subscribed', id: command.id })
        reconciliation.schedule(subscription)
      } catch (error) {
        if (!subscription.abortController.signal.aborted) {
          send({ op: 'subscribe-failed', id: command.id, message: errorMessage(error) })
        }
        if (subscriptions.get(command.id) === subscription) {
          subscriptions.delete(command.id)
          releaseWatcherReconciliationResources(subscription)
        }
      } finally {
        if (
          subscription.attached &&
          (subscription.abortController.signal.aborted ||
            subscriptions.get(command.id) !== subscription)
        ) {
          await bindingWatchdog
            .watch('unsubscribe', binding.unsubscribe(dir, callback, options))
            .catch(() => undefined)
          subscription.attached = false
        }
      }
    })()
  }

  const unsubscribe = async (id: number): Promise<void> => {
    const subscription = subscriptions.get(id)
    subscriptions.delete(id)
    if (subscription?.reconcileTimer) {
      clearTimeout(subscription.reconcileTimer)
      subscription.reconcileTimer = null
    }
    subscription?.abortController.abort()
    if (subscription) {
      releaseWatcherReconciliationResources(subscription)
    }
    try {
      await subscription?.ready
      if (subscription?.attached) {
        await bindingWatchdog.watch(
          'unsubscribe',
          binding.unsubscribe(subscription.dir, subscription.callback, subscription.options)
        )
        subscription.attached = false
      }
    } catch (error) {
      process.stderr.write(`[wsl-watcher-host] unsubscribe ${id}: ${errorMessage(error)}\n`)
    }
    send({ op: 'unsubscribed', id })
  }

  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (!closing) {
      closing = Promise.all(Array.from(subscriptions.keys(), unsubscribe)).then(() => undefined)
    }
    return closing
  }

  const lines: Interface = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    const command = parseCommand(line)
    if (!command) {
      send({ op: 'protocol-error', message: 'invalid command' })
    } else if (command.op === 'subscribe') {
      subscribe(command)
    } else {
      void unsubscribe(command.id)
    }
  })
  lines.once('close', () => {
    void close().finally(() => exit(0))
  })
  send({ op: 'ready', protocol: 1 })
  return { close, bindingWatchdog }
}

function main(): void {
  const binding = require('./watcher.node') as NativeWatcherBinding
  if (process.argv.includes('--check')) {
    process.stdout.write('ok\n')
    return
  }
  const host = startWslWatcherHost(binding, process.stdin, process.stdout)
  // Why: the native watcher can remain alive while its delivery thread stalls;
  // a private canary converts that silent failure into a recoverable host exit.
  void startWslWatcherCanary(binding, host.bindingWatchdog).catch((error: unknown) => {
    process.stderr.write(`[wsl-watcher-host] canary unavailable: ${errorMessage(error)}\n`)
  })
}

if (require.main === module) {
  main()
}
