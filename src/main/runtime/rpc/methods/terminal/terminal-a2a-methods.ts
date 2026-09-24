import { defineMethod } from '../../core'
import { broadcastA2ALink } from '../../../../ipc/terminal-a2a'
import { parseTerminalIndex, type A2ALinkEvent } from '../../../../../shared/terminal-a2a-link'
import { TerminalA2ALink } from './unary-schemas'

export const TERMINAL_A2A_METHODS = [
  defineMethod({
    name: 'terminal.a2aLink',
    params: TerminalA2ALink,
    handler: async (params, ctx) => {
      const id = params.id || `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      let delivered = false
      let targetHandle: string | undefined
      let bytesWritten = 0
      let executionState: 'delivered' | 'failed' | 'simulated' = 'simulated'
      let errorMessage: string | undefined

      const shouldDispatch = params.dispatch !== false && Boolean(params.text)

      if (shouldDispatch && ctx?.runtime) {
        try {
          const listRes = await ctx.runtime.listTerminals()
          const terminals = listRes?.terminals ?? []

          const targetIndex = params.toIndex ?? parseTerminalIndex(params.to)
          let match = terminals.find((t) => t.handle === params.to)
          if (!match && targetIndex !== undefined) {
            match = terminals.find(
              (t: { index?: number }, idx: number) =>
                t.index === targetIndex || (!t.index && idx + 1 === targetIndex)
            )
          }
          if (!match && params.to.startsWith('@')) {
            const label = params.to.slice(1).toLowerCase()
            match = terminals.find(
              (t) =>
                t.title?.toLowerCase() === label ||
                t.preview?.toLowerCase().includes(label) ||
                t.branch?.toLowerCase() === label
            )
          }

          if (match) {
            targetHandle = match.handle
            let messageToSend = params.text ?? ''
            if (params.type === 'message') {
              const header = `[orca-bridge from:${params.from} to:${params.to}]`
              messageToSend = `${header} ${params.text}`
            }

            const sendRes = await ctx.runtime.sendTerminal(targetHandle, {
              text: messageToSend,
              enter: params.type !== 'type'
            })

            delivered = sendRes?.accepted ?? true
            bytesWritten = sendRes?.bytesWritten ?? messageToSend.length
            executionState = delivered ? 'delivered' : 'failed'
          } else {
            errorMessage = `No active terminal found for target "${params.to}"`
            executionState = 'failed'
          }
        } catch (err: unknown) {
          errorMessage = err instanceof Error ? err.message : String(err)
          executionState = 'failed'
        }
      }

      const event: A2ALinkEvent = {
        id,
        from: params.from,
        to: params.to,
        fromIndex: params.fromIndex,
        toIndex: params.toIndex,
        fromLabel: params.fromLabel,
        toLabel: params.toLabel,
        type: params.type ?? 'send',
        text: params.text,
        timestamp: params.timestamp ?? Date.now(),
        durationMs: params.durationMs,
        delivered,
        targetHandle,
        bytesWritten,
        executionState,
        error: errorMessage
      }

      broadcastA2ALink(event)
      return {
        ok: true,
        id,
        delivered,
        targetHandle,
        bytesWritten,
        executionState,
        error: errorMessage
      }
    }
  })
]
