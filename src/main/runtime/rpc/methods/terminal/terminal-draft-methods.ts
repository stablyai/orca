import { defineMethod } from '../../core'
import {
  TerminalDraftBegin,
  TerminalDraftRelease,
  TerminalDraftSave,
  TerminalDraftSubmit
} from '../../../../../shared/rpc-contract/terminal-draft-params'
import { assertTerminalSendTextWithinLimit } from './terminal-input-delivery'
import { getTerminalDraftCoordinator } from '../../../terminal/draft/terminal-draft-service'

/**
 * Draft editing is an additive capability. Old hosts answer "unsupported method", which clients
 * must treat exactly like a host that reports no bridge: keep typing into the terminal normally.
 */
export const TERMINAL_DRAFT_METHODS = [
  defineMethod({
    name: 'terminal.draft.begin',
    permission: 'workspace',
    params: TerminalDraftBegin,
    handler: async (params, { runtime }) => {
      const ptyId = runtime.resolveLiveLeafForHandle(params.terminal)?.ptyId
      if (!ptyId) {
        return { ok: false, supported: false, reason: 'not_live' }
      }
      return getTerminalDraftCoordinator().begin({
        ptyId,
        client: params.client,
        force: params.force
      })
    }
  }),
  defineMethod({
    name: 'terminal.draft.save',
    permission: 'workspace',
    params: TerminalDraftSave,
    handler: async (params, { runtime }) => {
      const ptyId = runtime.resolveLiveLeafForHandle(params.terminal)?.ptyId
      if (!ptyId) {
        return { ok: false, status: 'unsupported', reason: 'not_live' }
      }
      await assertTerminalSendTextWithinLimit(params.text)
      return getTerminalDraftCoordinator().save({
        ptyId,
        client: params.client,
        epoch: params.epoch,
        baseToken: params.baseToken,
        text: params.text,
        operationId: params.operationId
      })
    }
  }),
  defineMethod({
    name: 'terminal.draft.submit',
    permission: 'workspace',
    params: TerminalDraftSubmit,
    handler: async (params, { runtime, signal }) => {
      const ptyId = runtime.resolveLiveLeafForHandle(params.terminal)?.ptyId
      if (!ptyId) {
        return { ok: false, status: 'unsupported', reason: 'not_live' }
      }
      await assertTerminalSendTextWithinLimit(params.text)
      return getTerminalDraftCoordinator().submit({
        ptyId,
        client: params.client,
        epoch: params.epoch,
        baseToken: params.baseToken,
        text: params.text,
        operationId: params.operationId,
        submitInput: () =>
          runtime.sendTerminal(
            params.terminal,
            { enter: true },
            { inputKind: 'driving', signal, requireWriteSettlement: true }
          )
      })
    }
  }),
  defineMethod({
    name: 'terminal.draft.release',
    permission: 'workspace',
    params: TerminalDraftRelease,
    handler: async (params, { runtime }) => {
      const ptyId = runtime.resolveLiveLeafForHandle(params.terminal)?.ptyId
      return ptyId
        ? getTerminalDraftCoordinator().release({
            ptyId,
            epoch: params.epoch,
            client: params.client
          })
        : { ok: false }
    }
  })
]
