import type { PtyOwnershipTransferControl } from '../../shared/pty-ownership-transfer-control-wire'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { IPtyProvider, PtyProcessInfo } from './pty-provider-contract'

export type RuntimePtyOwnershipTransferControlProvider = Pick<
  IPtyProvider,
  'listProcesses' | 'resize' | 'sendSignal' | 'clearBuffer' | 'shutdown'
> &
  Pick<IPtyProvider, 'getAppliedSize'>

/** Applies one control without upgrading ambiguous provider outcomes to success. */
export async function applyRuntimePtyOwnershipTransferProviderControl(options: {
  provider: RuntimePtyOwnershipTransferControlProvider
  isCurrentProvider: () => boolean
  identity: PtyOwnershipTransferWireIdentity
  control: PtyOwnershipTransferControl
}): Promise<'applied' | 'unverifiable'> {
  if (!(await provesExactSource(options))) {
    return 'unverifiable'
  }
  try {
    switch (options.control.kind) {
      case 'resize':
        options.provider.resize(
          options.identity.terminalId,
          options.control.cols,
          options.control.rows
        )
        return await verifyResize(options, options.control.cols, options.control.rows)
      case 'shutdown':
        await options.provider.shutdown(options.identity.terminalId, {
          immediate: options.control.immediate,
          keepHistory: true
        })
        return await verifyShutdown(options)
      case 'sendSignal':
        await options.provider.sendSignal(options.identity.terminalId, options.control.signal)
        return 'unverifiable'
      case 'clearBuffer':
        await options.provider.clearBuffer(options.identity.terminalId)
        return 'unverifiable'
    }
  } catch {
    return 'unverifiable'
  }
}

async function verifyResize(
  options: Parameters<typeof applyRuntimePtyOwnershipTransferProviderControl>[0],
  cols: number,
  rows: number
): Promise<'applied' | 'unverifiable'> {
  const applied = await options.provider.getAppliedSize?.(options.identity.terminalId)
  if (
    !applied ||
    applied.cols !== cols ||
    applied.rows !== rows ||
    !(await provesExactSource(options))
  ) {
    return 'unverifiable'
  }
  return 'applied'
}

async function verifyShutdown(
  options: Parameters<typeof applyRuntimePtyOwnershipTransferProviderControl>[0]
): Promise<'applied' | 'unverifiable'> {
  const inventory = await readCurrentInventory(options)
  if (!inventory) {
    return 'unverifiable'
  }
  return inventory.some((process) => sameSource(process, options.identity))
    ? 'unverifiable'
    : 'applied'
}

async function provesExactSource(
  options: Parameters<typeof applyRuntimePtyOwnershipTransferProviderControl>[0]
): Promise<boolean> {
  const inventory = await readCurrentInventory(options)
  if (!inventory) {
    return false
  }
  const matches = inventory.filter((process) => process.id === options.identity.terminalId)
  return matches.length === 1 && sameSource(matches[0]!, options.identity)
}

async function readCurrentInventory(
  options: Parameters<typeof applyRuntimePtyOwnershipTransferProviderControl>[0]
): Promise<readonly PtyProcessInfo[] | null> {
  if (!options.isCurrentProvider()) {
    return null
  }
  try {
    const inventory = await options.provider.listProcesses()
    return options.isCurrentProvider() ? inventory : null
  } catch {
    return null
  }
}

function sameSource(process: PtyProcessInfo, identity: PtyOwnershipTransferWireIdentity): boolean {
  return process.id === identity.terminalId && process.incarnationId === identity.incarnationId
}
