type PendingRuntimeEnvironmentSubscriptionSetup = {
  environmentId: string
  ownerWebContentsId: number
  controller: AbortController
}

const pendingSetups = new Map<string, PendingRuntimeEnvironmentSubscriptionSetup>()

export function createRuntimeSubscriptionSetupAbortError(): Error {
  const error = new Error('Runtime environment subscription setup aborted')
  error.name = 'AbortError'
  return error
}

export function hasRuntimeEnvironmentSubscriptionSetup(subscriptionId: string): boolean {
  return pendingSetups.has(subscriptionId)
}

export function isRuntimeEnvironmentSubscriptionSetupCurrent(
  subscriptionId: string,
  controller: AbortController
): boolean {
  return pendingSetups.get(subscriptionId)?.controller === controller
}

export function beginRuntimeEnvironmentSubscriptionSetup(args: {
  subscriptionId: string
  environmentId: string
  ownerWebContentsId: number
}): AbortController {
  if (pendingSetups.has(args.subscriptionId)) {
    throw new Error('Runtime environment subscription id already exists')
  }
  const controller = new AbortController()
  pendingSetups.set(args.subscriptionId, {
    environmentId: args.environmentId,
    ownerWebContentsId: args.ownerWebContentsId,
    controller
  })
  return controller
}

export function finishRuntimeEnvironmentSubscriptionSetup(
  subscriptionId: string,
  controller: AbortController
): void {
  if (pendingSetups.get(subscriptionId)?.controller === controller) {
    pendingSetups.delete(subscriptionId)
  }
}

export function cancelRuntimeEnvironmentSubscriptionSetup(
  subscriptionId: string,
  ownerWebContentsId: number
): boolean {
  const pending = pendingSetups.get(subscriptionId)
  if (!pending || pending.ownerWebContentsId !== ownerWebContentsId) {
    return false
  }
  pendingSetups.delete(subscriptionId)
  pending.controller.abort()
  return true
}

export function cancelRuntimeEnvironmentSubscriptionSetupsForEnvironment(
  environmentId: string
): void {
  for (const [subscriptionId, pending] of pendingSetups) {
    if (pending.environmentId === environmentId) {
      pendingSetups.delete(subscriptionId)
      pending.controller.abort()
    }
  }
}

export function cancelAllRuntimeEnvironmentSubscriptionSetups(): void {
  for (const pending of pendingSetups.values()) {
    pending.controller.abort()
  }
  pendingSetups.clear()
}
