import { sendToPtyOwner } from './pty'
import { sendTerminalWindowTransferCommand } from './terminal-window-transfer-command'
import type {
  TerminalWindowTransfer,
  TerminalWindowTransferOperations
} from './terminal-window-transfer-operation'
import {
  removeTransferredTerminalSession,
  removeTransferredTerminalSessionBacking,
  restoreTransferredTerminalSession
} from './terminal-window-transfer-session-patch'

export async function rollbackTerminalWindowTransfer(
  operations: TerminalWindowTransferOperations,
  transfer: TerminalWindowTransfer
): Promise<void> {
  if (transfer.committed) {
    return
  }
  const { source, sourceRenderer, target, targetRenderer, seed } = transfer
  const canHandoffBack =
    !transfer.targetLost ||
    (!sourceRenderer.isDestroyed() &&
      operations.owners.isRegistered(sourceRenderer) &&
      operations.owners.isDispatcherReady(sourceRenderer))
  if (transfer.prepared && transfer.handedOff && targetRenderer && canHandoffBack) {
    try {
      operations.handoff(seed.ptyIds, targetRenderer, sourceRenderer)
      transfer.handedOff = false
    } catch {
      if (!transfer.targetLost) {
        try {
          await operations.owners.waitUntilDispatcherReady(sourceRenderer, operations.timeoutMs)
          operations.handoff(seed.ptyIds, targetRenderer, sourceRenderer)
          transfer.handedOff = false
        } catch {
          // Keep the PTY with its last live owner; durable source backing remains available.
        }
      }
    }
  }
  const commands: Promise<unknown>[] = []
  if (
    transfer.prepared &&
    transfer.targetImportAttempted &&
    targetRenderer &&
    !targetRenderer.isDestroyed()
  ) {
    commands.push(
      sendTerminalWindowTransferCommand(
        operations,
        transfer,
        targetRenderer,
        { transferId: transfer.transferId, tabId: seed.tabId, phase: 'target-remove' },
        true
      ).catch(() => undefined)
    )
  }
  if (transfer.prepared && transfer.sourceRemoveAttempted && !sourceRenderer.isDestroyed()) {
    commands.push(
      sendTerminalWindowTransferCommand(
        operations,
        transfer,
        sourceRenderer,
        { transferId: transfer.transferId, tabId: seed.tabId, phase: 'source-restore', seed },
        true
      ).catch(() => undefined)
    )
  }
  await Promise.all(commands)
  if (transfer.prepared && seed.ptyIds.every((id) => operations.owners.owns(id, sourceRenderer))) {
    for (const id of seed.ptyIds) {
      try {
        sendToPtyOwner(id, 'pty:modelRestoreNeeded', { id, reason: 'delivery-heal' })
      } catch {
        // Delivery healing is best-effort after ownership is restored.
      }
    }
  }
  if (transfer.prepared) {
    try {
      operations.sessions.set(
        source.id,
        restoreTransferredTerminalSession(
          operations.sessions.get(source.id, seed.hostId),
          transfer.sourceBefore,
          seed
        ),
        seed.hostId
      )
    } catch {
      // Renderer compensation already ran when available; session fallback is best-effort.
    }
    if (target && transfer.targetBefore) {
      try {
        operations.sessions.set(
          target.id,
          removeTransferredTerminalSession(
            operations.sessions.get(target.id, seed.hostId),
            transfer.targetBefore,
            seed
          ),
          seed.hostId
        )
      } catch {
        // Preserve the original transfer error.
      }
    }
  }
  if (transfer.createdTarget && target) {
    try {
      transfer.disposeTargetRenderer?.()
    } catch {
      // Target destruction remains the final cleanup attempt.
    }
    if (targetRenderer) {
      try {
        operations.owners.removeRenderer(targetRenderer)
      } catch {
        // The exact disposer remains the primary registration cleanup.
      }
    }
    try {
      operations.sessions.retire(target.id, 'empty-close')
    } catch {
      // Target destruction remains the final cleanup attempt.
    }
    if (!target.isDestroyed()) {
      try {
        target.destroy()
      } catch {
        // Preserve the original transfer error.
      }
    }
  }
}

export async function commitTerminalWindowTransferAfterSourceLoss(
  operations: TerminalWindowTransferOperations,
  transfer: TerminalWindowTransfer
): Promise<boolean> {
  const { source, target, targetRenderer, seed } = transfer
  if (
    !transfer.sourceLost ||
    transfer.targetLost ||
    !transfer.handedOff ||
    !target ||
    !targetRenderer ||
    targetRenderer.isDestroyed() ||
    !seed.ptyIds.every((id) => operations.owners.owns(id, targetRenderer))
  ) {
    return false
  }
  if (!transfer.targetImported) {
    try {
      await sendTerminalWindowTransferCommand(
        operations,
        transfer,
        targetRenderer,
        { transferId: transfer.transferId, tabId: seed.tabId, phase: 'target-import', seed },
        true
      )
      transfer.targetImported = true
    } catch {
      // Main-process backing remains the durable fallback.
    }
  }
  try {
    operations.sessions.set(
      target.id,
      restoreTransferredTerminalSession(
        operations.sessions.get(target.id, seed.hostId),
        transfer.sourceBefore,
        seed
      ),
      seed.hostId
    )
  } catch {
    // WindowSessionRegistry mutates its record before persistence can fail.
  }
  try {
    operations.sessions.set(
      source.id,
      removeTransferredTerminalSessionBacking(
        operations.sessions.get(source.id, seed.hostId),
        seed
      ),
      seed.hostId
    )
  } catch {
    // The live target remains authoritative if source cleanup persistence fails.
  }
  transfer.committed = true
  transfer.handedOff = false
  return true
}
