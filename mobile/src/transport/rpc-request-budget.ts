type RpcRequestBudgetOptions = {
  timeoutMs?: number
  budgetSpansConnect?: boolean
}

export type RpcRequestBudget = {
  startedAt: number
  timeoutMs?: number
  deadline: number | null
}

export const RPC_REQUEST_MIN_ACK_MS = 1_000

export function openRpcRequestBudget(
  options?: RpcRequestBudgetOptions,
  now = Date.now()
): RpcRequestBudget {
  const timeoutMs = options?.timeoutMs
  return {
    startedAt: now,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    deadline: options?.budgetSpansConnect && timeoutMs !== undefined ? now + timeoutMs : null
  }
}

export function resolvePostConnectRequestTimeout(
  budget: RpcRequestBudget,
  fallbackMs: number,
  now = Date.now()
): number {
  if (budget.deadline === null) {
    return budget.timeoutMs ?? fallbackMs
  }
  return Math.max(
    Math.min(RPC_REQUEST_MIN_ACK_MS, budget.deadline - budget.startedAt),
    budget.deadline - now
  )
}
