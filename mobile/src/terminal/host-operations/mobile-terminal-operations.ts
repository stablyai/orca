import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import {
  terminalAutoRestoreFitSchema,
  terminalBufferClearedSchema,
  terminalSendAcceptedSchema,
  terminalInputSessionSchema,
  terminalProcessInspectionSchema,
  terminalViewportUpdatedSchema
} from './terminal-reply-schema'
import { sessionWriteUnreadReplySchema } from '../../transport/rpc/rpc-uninterpreted-reply-schemas'

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

export const terminalInputSessionOpen = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.input-session-open',
    method: 'terminal.openInputSession',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-input-session', terminalInputSessionSchema)
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

/** A clear is successful only when the host confirms its buffer was cleared. */
export const terminalBufferClear = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.clear-buffer',
    method: 'terminal.clearBuffer',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-buffer-cleared', terminalBufferClearedSchema)
  })
)

// Read-only process evidence for one terminal; a refusal or odd reply proves nothing.
export const terminalProcessInspect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.inspect-process',
    method: 'terminal.inspectProcess',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-process-inspection', terminalProcessInspectionSchema)
  })
)

// Waits for a terminal's exit; only settling matters, so the reply stays unread.
export const terminalExitWait = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.exit-wait',
    method: 'terminal.wait',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-exit-waited', sessionWriteUnreadReplySchema)
  })
)
