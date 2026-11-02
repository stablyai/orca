/** A host's keepalive for one outstanding long poll: no response id, so older readers skip it. */
export function rpcRequestKeepaliveId(frame: unknown): string | null {
  if (typeof frame !== 'object' || frame === null || !('_keepalive' in frame)) {
    return null
  }
  const { _keepalive: keepalive, requestId } = frame as { _keepalive: unknown; requestId?: unknown }
  return keepalive === true && typeof requestId === 'string' ? requestId : null
}

export type RpcRequestDeadline = { renew: () => void; clear: () => void }

/** A request's idle timeout, renewed only by its own keepalives and never past its total allowance. */
export function startRpcRequestDeadline(
  idleMs: number,
  totalMs: number | undefined,
  onExpire: () => void
): RpcRequestDeadline {
  const expire = (): void => {
    clear()
    onExpire()
  }
  let idle = setTimeout(expire, idleMs)
  const total = setTimeout(expire, Math.max(idleMs, totalMs ?? idleMs))
  function clear(): void {
    clearTimeout(idle)
    clearTimeout(total)
  }
  return {
    renew: () => {
      clearTimeout(idle)
      idle = setTimeout(expire, idleMs)
    },
    clear
  }
}
