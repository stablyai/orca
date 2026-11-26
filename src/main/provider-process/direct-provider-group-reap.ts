import { constants } from 'node:os'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/process-exits/self-initiated-tree-kill-log'
import {
  type publishProviderOwnership,
  waitForProviderGroupReap,
  waitForProviderOwnershipReap
} from './provider-ownership-journal'
import { sweepOrphanedProviderGroup } from './provider-group-orphan-guard'
import { PROVIDER_GROUP_REAP_TIMEOUT_MS } from './provider-process-supervisor'
import type { ProviderControlCompletion } from './provider-control-completion'
import type { ProviderChild } from './provider-child'

export function reapDirectProviderGroup(
  delivered: boolean,
  pid: () => number | undefined,
  ownership: () => Promise<Awaited<ReturnType<typeof publishProviderOwnership>>> | undefined,
  setVerdict: (verdict: 'exited' | 'unverifiable') => void,
  descendantsCleaned: () => Promise<boolean>,
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
    if (completion === 'group-absent') {
      // The native frame plus EOF proves the group was absent and the session watcher exited.
      setVerdict('exited')
      // Group absence says nothing about own-session tools whose fault capture failed.
      if (await descendantsCleaned()) {
        await (await ownership())?.removeAfterNativeExit()
      }
      return
    }
    const registered = await ownership()
    if (!delivered && registered) {
      await sweepOrphanedProviderGroup(registered.identity, { signal: proof.signal })
    }
    if (proof.signal.aborted) {
      return
    }
    const groupPid = pid()
    const remaining = Math.max(0, deadline - performance.now())
    const absent = groupPid
      ? await waitForProviderGroupReap(groupPid, remaining, proof.signal)
      : false
    if (proof.signal.aborted) {
      return
    }
    setVerdict(absent ? 'exited' : 'unverifiable')
    if (
      absent &&
      registered &&
      (await waitForProviderOwnershipReap(
        registered.identity,
        Math.max(0, deadline - performance.now()),
        proof.signal
      )) &&
      (await descendantsCleaned())
    ) {
      await registered.remove()
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
    })
}

export function signalDirectProviderRoot(pid: number, signal: NodeJS.Signals | number): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

export function signalLiveDirectProviderRoot(
  child: Pick<ProviderChild, 'writerPid' | 'numericIdentityRetired'> & { killed: boolean },
  signal: NodeJS.Signals | number
): boolean {
  // SIGSTOP pins only the held root; stopping W would disable the independent backstop.
  const delivered =
    !child.numericIdentityRetired &&
    child.writerPid !== undefined &&
    signalDirectProviderRoot(child.writerPid, signal)
  if (delivered && signal !== 0) {
    child.killed = true
  }
  return delivered
}

export function signalDirectProviderGroup(
  child: Pick<ProviderChild, 'writerPid' | 'numericIdentityRetired'> & { killed: boolean },
  signal: NodeJS.Signals
): boolean {
  const pid = child.writerPid
  if (!pid || child.numericIdentityRetired) {
    return false
  }
  try {
    process.kill(-pid, signal)
    child.killed = true
  } catch {
    // The leader's session is fixed before its pid is known, so a missing group means a missing leader.
    return false
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

export function isProviderProbeOrPause(signal: NodeJS.Signals | number): boolean {
  return signal === 0 || signal === 'SIGSTOP' || signal === constants.signals.SIGSTOP
}

export function isProviderReapSignal(signal: NodeJS.Signals | number): boolean {
  return (
    signal === 'SIGUSR2' ||
    signal === constants.signals.SIGUSR2 ||
    signal === 'SIGKILL' ||
    signal === constants.signals.SIGKILL
  )
}

export async function joinCurrentProviderReap(
  current: () => Promise<void> | undefined
): Promise<void> {
  let attempt: Promise<void> | undefined
  do {
    attempt = current()
    await attempt
  } while (attempt !== current())
}
