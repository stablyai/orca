import { waitForMobileInputLeaseReady } from './mobile-input-lease-ready'

export function canRetryMobileNativeChatSend(
  originalHandle: string,
  recoveredHandle: string | null,
  expectedSessionTabId: string | null,
  activeSessionTabId: string | null,
  hasPastedImages: boolean
): recoveredHandle is string {
  return (
    recoveredHandle != null &&
    activeSessionTabId === expectedSessionTabId &&
    (!hasPastedImages || recoveredHandle === originalHandle)
  )
}

type MobileNativeChatInputRecoveryArgs = {
  rejectedHandle: string
  expectedSessionTabId: string | null
  isConnected: () => boolean
  getActiveHandle: () => string | null
  getActiveSessionTabId: () => string | null
  isActiveTerminal: () => boolean
  isLeaseReady: () => boolean
  reconcile: () => Promise<void>
  unsubscribe: (handle: string) => void
  subscribe: (handle: string) => void
}

type MobileNativeChatInputRecoveryDependencies = Omit<
  MobileNativeChatInputRecoveryArgs,
  'rejectedHandle' | 'expectedSessionTabId'
>

export function createMobileNativeChatInputRecovery(
  dependencies: MobileNativeChatInputRecoveryDependencies
): (rejectedHandle: string, expectedSessionTabId: string | null) => Promise<boolean> {
  return (rejectedHandle, expectedSessionTabId) =>
    recoverMobileNativeChatInput({
      ...dependencies,
      rejectedHandle,
      expectedSessionTabId
    })
}

function isCurrentTerminal(args: MobileNativeChatInputRecoveryArgs, handle: string): boolean {
  return (
    args.isConnected() &&
    args.isActiveTerminal() &&
    args.getActiveHandle() === handle &&
    args.getActiveSessionTabId() === args.expectedSessionTabId
  )
}

export async function recoverMobileNativeChatInput(
  args: MobileNativeChatInputRecoveryArgs
): Promise<boolean> {
  if (!isCurrentTerminal(args, args.rejectedHandle)) {
    return false
  }

  args.unsubscribe(args.rejectedHandle)
  try {
    await args.reconcile()
  } catch {
    // A renewed subscription can still recover a transient reconciliation failure.
  }

  const handle = args.getActiveHandle()
  if (!handle || !isCurrentTerminal(args, handle)) {
    return false
  }

  args.unsubscribe(handle)
  args.subscribe(handle)
  return waitForMobileInputLeaseReady({
    isCurrent: () => isCurrentTerminal(args, handle),
    isReady: args.isLeaseReady
  })
}
