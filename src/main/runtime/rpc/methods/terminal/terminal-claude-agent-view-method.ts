import { defineMethod, defineStreamingMethod } from '../../core'
import { bindStructuredAgentSessionStream } from '../structured-agent-session-status-stream'
import { TerminalViewClaudeAgent } from '../../../../../shared/rpc-contract/terminal-unary-params'
import { agentHookServer } from '../../../../agent-hooks/server'
import { assertTerminalAgentSendable } from '../../terminal-agent-send-guard'
import {
  assertTerminalSendExactPtyBinding,
  isTerminalInputLockedForClient
} from './terminal-input-delivery'
import type { ClaudeAgentViewResult } from '../../../../../shared/claude-agent-view'

export const TERMINAL_CLAUDE_AGENT_VIEW_METHODS = [
  defineStreamingMethod({
    name: 'terminal.subscribeClaudeAgentViews',
    permission: 'workspace',
    params: null,
    handler: async (_params, ctx, emit) => {
      let dispose = () => {}
      const id = `claude-agent-views:${ctx.connectionId ?? 'local'}:${ctx.requestId ?? ''}`
      const stream = bindStructuredAgentSessionStream(ctx, id, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = agentHookServer.claudeAgentViews.subscribe(emit)
      if (stream.isClosed()) {
        dispose()
      }
    }
  }),
  defineMethod({
    name: 'terminal.viewClaudeAgent',
    permission: 'workspace',
    params: TerminalViewClaudeAgent,
    handler: async (params, { runtime, signal }): Promise<{ view: ClaudeAgentViewResult }> => {
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      const ptyId = leaf?.ptyId
      const paneKey = runtime.getLiveTerminalPaneKey(params.terminal)
      if (!ptyId || !paneKey || isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
        return { view: { status: 'unavailable' } }
      }
      const rows = agentHookServer.getStatusSnapshotForPane(paneKey)
      if (
        !rows.some(
          (row) => row.agentType === 'claude' && row.providerSession?.id === params.sessionId
        )
      ) {
        return { view: { status: 'unsupported' } }
      }
      const assertWritable = () => {
        assertTerminalSendExactPtyBinding(runtime, params.terminal, ptyId)
        if (isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
          throw new Error('terminal_guard_not_writable')
        }
      }
      try {
        const view = await agentHookServer.claudeAgentViews.view({
          paneKey,
          sessionId: params.sessionId,
          agentId: params.agentId,
          signal,
          trigger: async (input, isCurrent) => {
            const assertCurrent = () => {
              assertWritable()
              if (
                !isCurrent() ||
                !agentHookServer
                  .getStatusSnapshotForPane(paneKey)
                  .some(
                    (row) =>
                      row.agentType === 'claude' && row.providerSession?.id === params.sessionId
                  )
              ) {
                throw new Error('terminal_guard_not_writable')
              }
            }
            await assertTerminalAgentSendable({
              runtime,
              handle: params.terminal,
              assertWritable: assertCurrent
            })
            const status = await runtime.getTerminalAgentStatus(params.terminal)
            if (status.status === 'permission') {
              throw new Error('terminal_guard_permission')
            }
            const result = await runtime.sendTerminal(
              params.terminal,
              { text: input },
              {
                inputKind: 'driving',
                signal,
                beforeWrite: async () => {
                  await assertTerminalAgentSendable({
                    runtime,
                    handle: params.terminal,
                    assertWritable: assertCurrent
                  })
                }
              }
            )
            return result.accepted
          }
        })
        return { view }
      } catch (error) {
        if (error instanceof Error && error.message === 'terminal_guard_permission') {
          return { view: { status: 'permission' } }
        }
        if (
          error instanceof Error &&
          ['terminal_guard_not_writable', 'terminal_guard_no_agent'].includes(error.message)
        ) {
          return { view: { status: 'unavailable' } }
        }
        throw error
      }
    }
  })
]
