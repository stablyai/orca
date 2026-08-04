export type MobileNativeChatTerminalLease = {
  readonly terminal: string
  readonly kind: 'write' | 'stop'
  release: () => void
}

export type MobileNativeChatTerminalLeaseRequest = {
  readonly acquired: Promise<MobileNativeChatTerminalLease | null>
  cancel: () => void
}

type PendingLease = {
  readonly kind: MobileNativeChatTerminalLease['kind']
  readonly token: object
  readonly resolve: (lease: MobileNativeChatTerminalLease | null) => void
  granted: boolean
  lease: MobileNativeChatTerminalLease | null
}

type TerminalLeaseQueue = {
  active: PendingLease | null
  stop: PendingLease | null
  readonly writes: PendingLease[]
}

const queues = new Map<string, TerminalLeaseQueue>()

function deleteIdleQueue(terminal: string, queue: TerminalLeaseQueue): void {
  if (!queue.active && !queue.stop && queue.writes.length === 0 && queues.get(terminal) === queue) {
    queues.delete(terminal)
  }
}

function grantNext(terminal: string, queue: TerminalLeaseQueue): void {
  if (queue.active) {
    return
  }
  const pending = queue.stop ?? queue.writes.shift() ?? null
  if (!pending) {
    deleteIdleQueue(terminal, queue)
    return
  }
  if (queue.stop === pending) {
    queue.stop = null
  }
  pending.granted = true
  queue.active = pending
  const lease: MobileNativeChatTerminalLease = {
    terminal,
    kind: pending.kind,
    release: () => {
      if (queues.get(terminal) !== queue || queue.active?.token !== pending.token) {
        return
      }
      queue.active = null
      grantNext(terminal, queue)
    }
  }
  pending.lease = lease
  pending.resolve(lease)
}

function requestLease(
  terminal: string,
  kind: MobileNativeChatTerminalLease['kind']
): MobileNativeChatTerminalLeaseRequest | null {
  const queue = queues.get(terminal) ?? { active: null, stop: null, writes: [] }
  queues.set(terminal, queue)
  if (kind === 'stop' && (queue.active?.kind === 'stop' || queue.stop)) {
    return null
  }
  let resolve!: PendingLease['resolve']
  const pending: PendingLease = {
    kind,
    token: {},
    resolve: (lease) => resolve(lease),
    granted: false,
    lease: null
  }
  const acquired = new Promise<MobileNativeChatTerminalLease | null>((complete) => {
    resolve = complete
  })
  if (kind === 'stop') {
    queue.stop = pending
  } else {
    queue.writes.push(pending)
  }
  grantNext(terminal, queue)
  return {
    acquired,
    cancel: () => {
      if (pending.granted || queues.get(terminal) !== queue) {
        return
      }
      pending.granted = true
      if (queue.stop === pending) {
        queue.stop = null
      } else {
        const index = queue.writes.indexOf(pending)
        if (index >= 0) {
          queue.writes.splice(index, 1)
        }
      }
      pending.resolve(null)
      grantNext(terminal, queue)
    }
  }
}

export function requestMobileNativeChatWriteLease(
  terminal: string
): MobileNativeChatTerminalLeaseRequest {
  return requestLease(terminal, 'write')!
}

export function requestMobileNativeChatStopLease(
  terminal: string
): MobileNativeChatTerminalLeaseRequest | null {
  return requestLease(terminal, 'stop')
}

export function ownsMobileNativeChatWriteLease(
  lease: MobileNativeChatTerminalLease,
  terminal: string
): boolean {
  const active = queues.get(terminal)?.active
  return active?.kind === 'write' && active.lease === lease && lease.terminal === terminal
}

export function resetMobileNativeChatStopLeasesForTests(): void {
  const pending = [...queues.values()].flatMap((queue) => [queue.stop, ...queue.writes])
  queues.clear()
  for (const lease of pending) {
    lease?.resolve(null)
  }
}
