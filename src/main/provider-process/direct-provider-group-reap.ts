import { constants } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/process-exits/self-initiated-tree-kill-log'
import {
  type publishProviderOwnership,
  waitForProviderGroupReap,
  waitForProviderOwnershipReap
} from './provider-ownership-journal'
import { sweepOrphanedProviderGroup } from './provider-group-orphan-guard'
import { PROVIDER_GROUP_REAP_TIMEOUT_MS } from './provider-process-supervisor'
import type { ProviderControlCompletion } from './provider-control-completion'

export function reapDirectProviderGroup(
  delivered: boolean,
  pid: () => number | undefined,
  ownership: () => Awaited<ReturnType<typeof publishProviderOwnership>> | undefined,
  setVerdict: (verdict: 'exited' | 'unverifiable') => void,
  onFinished: () => void,
  completion?: ProviderControlCompletion,
  canceled?: AbortSignal
): Promise<void> {
  const proof = new AbortController()
  const abort = (): void => proof.abort()
  canceled?.addEventListener('abort', abort, { once: true })
  if (canceled?.aborted) {
    proof.abort()
  }
  const deadline = performance.now() + PROVIDER_GROUP_REAP_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  const cleanup = async (): Promise<void> => {
    if (proof.signal.aborted) {
      return
    }
    if (completion === 'group-unverifiable') {
      setVerdict('unverifiable')
      return
    }
    const registered = ownership()
    if (completion === 'group-absent') {
      // The native frame plus EOF proves the group was absent and the session watcher exited.
      setVerdict('exited')
      await registered?.removeAfterNativeExit()
      return
    }
    if (!completion && !delivered && registered) {
      await sweepOrphanedProviderGroup(registered.identity, { signal: proof.signal })
    }
    if (proof.signal.aborted) {
      return
    }
    const groupPid = pid()
    const remaining = Math.max(0, deadline - performance.now())
    const absent = registered
      ? await waitForProviderOwnershipReap(registered.identity, remaining, proof.signal)
      : !groupPid
    if (!registered && !completion && groupPid) {
      // Before registration only the native completion can also prove the watcher exited.
      await waitForProviderGroupReap(groupPid, remaining, proof.signal)
    }
    if (proof.signal.aborted) {
      return
    }
    setVerdict(absent ? 'exited' : 'unverifiable')
    if (absent) {
      await ownership()?.remove()
    }
  }
  return Promise.race([
    cleanup(),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        proof.abort()
        resolve()
      }, PROVIDER_GROUP_REAP_TIMEOUT_MS)
    })
  ])
    .catch(() => {
      if (!proof.signal.aborted) {
        setVerdict('unverifiable')
      }
    })
    .finally(() => {
      clearTimeout(timer)
      canceled?.removeEventListener('abort', abort)
      if (!canceled?.aborted) {
        onFinished()
      }
    })
}

export function signalDirectProviderGroup(
  raw: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
  recordDelivery: (delivered: boolean) => void
): boolean {
  try {
    process.kill(-pid, signal)
    recordDelivery(true)
  } catch {
    const delivered = raw.kill(signal)
    recordDelivery(delivered)
    return delivered
  }
  if (signal === 'SIGKILL') {
    recordSelfInitiatedTreeKill({
      pid,
      site: 'provider-process-lifecycle',
      scope: 'posix-process-group'
    })
  }
  return true
}

export function isProviderTermSignal(signal: NodeJS.Signals | number): boolean {
  return (
    signal === 'SIGTERM' ||
    signal === 'SIGINT' ||
    signal === 'SIGHUP' ||
    signal === constants.signals.SIGTERM ||
    signal === constants.signals.SIGINT ||
    signal === constants.signals.SIGHUP
  )
}

export function isProviderReapSignal(signal: NodeJS.Signals | number): boolean {
  return (
    signal === 'SIGUSR2' ||
    signal === constants.signals.SIGUSR2 ||
    signal === 'SIGKILL' ||
    signal === constants.signals.SIGKILL
  )
}
