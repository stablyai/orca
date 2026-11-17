import { notifyRuntimeListeners } from '../runtime/events/runtime-listener-delivery'
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { EventEmitter } from 'node:events'
import type { DescendantTreeVerdict } from '../pty/process-retirement/pty-descendant-exit-verification'

export type ProviderChild = Pick<
  ChildProcessWithoutNullStreams,
  | 'pid'
  | 'stdin'
  | 'stdout'
  | 'stderr'
  | 'connected'
  | 'killed'
  | 'exitCode'
  | 'signalCode'
  | 'kill'
> &
  EventEmitter & {
    /** Actual CLI writer, which differs from the root on the compatibility path. */
    readonly writerPid?: number
    ready?: Promise<void>
    /** Group observation is independent of the real leader's outcome. */
    readonly groupVerdict?: DescendantTreeVerdict
    /** The CLI ran, but its real exit code or signal could not be recovered. */
    readonly outcomeLost?: boolean
    /** Proven root absence; group cleanup alone supplies no CLI wait status. */
    readonly leaderExited?: boolean
    /** Lost outcome or retirement revokes unvalidated numeric signals without proving exit. */
    readonly numericIdentityRetired?: boolean
  }

/** The native owner process: a direct child, or one whose launch completes asynchronously. */
export type ProviderOwnerProcess = Pick<ChildProcess, 'pid' | 'stdout' | 'stderr'> &
  EventEmitter & { readonly stdio?: readonly (Readable | Writable | null | undefined)[] }

/** A hosted launch reports its PID later; a failed spawn reports only its error. */
export function providerOwnerLaunched(raw: ProviderOwnerProcess): Promise<Error | null> {
  return new Promise((resolve) => {
    raw.once('spawn', () => resolve(null))
    raw.once('error', resolve)
  })
}

/** Native children expose `pid` only once the CLI runs; a failed launch leaves it unset. */
export async function awaitProviderChildSpawn(child: ProviderChild): Promise<void> {
  await child.ready?.catch(() => {})
}

export function notifyProviderChild(child: EventEmitter, event: string, ...args: unknown[]): void {
  notifyRuntimeListeners(
    child.rawListeners(event),
    (listener) => listener.apply(child, args),
    `provider ${event}`
  )
}

/** Late transport errors must not retain a launch's closure scope. */
export function ignoreProviderTransportError(): void {}
