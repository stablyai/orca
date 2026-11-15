import { notifyRuntimeListeners } from '../runtime/events/runtime-listener-delivery'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
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
    spawnAbsenceKnown?: boolean
    /** Actual CLI writer, which differs from the root on the compatibility path. */
    readonly writerPid?: number
    ready?: Promise<void>
    /** Group observation is independent of the real leader's outcome. */
    readonly groupVerdict?: DescendantTreeVerdict
    /** Prevent PID-based tree reads after the held OS root has actually exited. */
    readonly leaderExited?: boolean
    /** Lost outcome or retirement revokes unvalidated numeric signals without proving exit. */
    readonly numericIdentityRetired?: boolean
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
