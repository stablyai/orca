import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  terminalAutoRestoreFitSchema,
  terminalSendAcceptedSchema,
  terminalViewportUpdatedSchema,
  terminalWriteUnreadReplySchema
} from './terminal-reply-schema'

// All terminal writers share object-result-or-null; changing it would change lost-ack handling for every input surface.
export const terminalInputSend = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.input-send',
    method: 'terminal.send',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-send-accepted', terminalSendAcceptedSchema)
  })
)

// Inspect raw refusal code to detect unsupported in-place viewport updates.
export const terminalViewportUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.viewport-update',
    method: 'terminal.updateViewport',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-viewport-updated', terminalViewportUpdatedSchema)
  })
)

export const terminalAutoRestoreFitRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.auto-restore-fit-read',
    method: 'terminal.getAutoRestoreFit',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-auto-restore-fit', terminalAutoRestoreFitSchema)
  })
)

export const terminalAutoRestoreFitSave = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.auto-restore-fit-save',
    method: 'terminal.setAutoRestoreFit',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-auto-restore-fit', terminalAutoRestoreFitSchema)
  })
)

// Takeover retry uses fixed failure copy; skip refusal instead of surfacing an unused host message.
export const workerTerminalTakeoverReport = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'orchestration.worker-terminal-input-or-skip',
    method: 'orchestration.workerTerminalUserInput',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worker-terminal-input-reported', terminalWriteUnreadReplySchema)
  })
)

// Preserve legacy clear semantics: fulfilled replies report success; only transport rejection reaches failure copy.
export const terminalBufferClear = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.clear-buffer-or-skip',
    method: 'terminal.clearBuffer',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-buffer-cleared', terminalWriteUnreadReplySchema)
  })
)
