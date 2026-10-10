import { defineMethod } from '../../core'
import {
  TerminalHandle,
  TerminalInspectProcess,
  TerminalListParams,
  TerminalRead,
  TerminalRecoverPane,
  TerminalRename,
  TerminalResolveActive,
  TerminalResolvePane
} from '../../../../../shared/rpc-contract/terminal-unary-params'

export const TERMINAL_QUERY_METHODS = [
  defineMethod({
    name: 'terminal.list',
    permission: 'workspace',
    params: TerminalListParams,
    handler: async (params, { runtime }) =>
      runtime.listTerminals(params.worktree, params.limit, {
        handles: params.handles,
        requireFreshPtyLiveness: params.requireFreshPtyLiveness,
        includeVisualLayouts: params.includeVisualLayouts
      })
  }),
  defineMethod({
    name: 'terminal.resolveActive',
    permission: 'workspace',
    params: TerminalResolveActive,
    handler: async (params, { runtime }) => ({
      handle: await runtime.resolveActiveTerminal(
        params.worktree,
        params.requireUnambiguous ? { requireUnambiguous: true } : {}
      )
    })
  }),
  defineMethod({
    name: 'terminal.resolvePane',
    permission: 'workspace',
    params: TerminalResolvePane,
    handler: async (params, { runtime }) => ({
      terminal: runtime.resolveTerminalPane(params.paneKey, params.worktreeId)
    })
  }),
  defineMethod({
    name: 'terminal.recoverPane',
    permission: 'workspace',
    params: TerminalRecoverPane,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.recoverTerminalPane(
        params.paneKey,
        params.worktreeId,
        params.expectedTerminal
      )
    })
  }),
  defineMethod({
    name: 'terminal.show',
    permission: 'workspace',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.showTerminal(params.terminal)
    })
  }),
  defineMethod({
    // Read-only identity probe. Deliberately NOT `terminal.show`: this one resolves a structured
    // worker too, and must therefore never hand back anything that looks writable.
    name: 'terminal.resolveIdentity',
    permission: 'workspace',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      identity: runtime.resolveTerminalIdentity(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.read',
    permission: 'workspace',
    params: TerminalRead,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.readTerminal(params.terminal, {
        cursor: params.cursor,
        limit: params.limit,
        screen: params.screen
      })
    })
  }),
  defineMethod({
    name: 'terminal.inspectProcess',
    permission: 'workspace',
    params: TerminalInspectProcess,
    handler: async (params, { runtime }) => {
      const options = {
        ...(params.expectedIncarnationId
          ? { expectedIncarnationId: params.expectedIncarnationId }
          : {}),
        ...(params.scanChildProcesses === true ? { scanChildProcesses: true } : {})
      }
      return {
        process: await runtime.inspectTerminalProcess(
          params.terminal,
          Object.keys(options).length > 0 ? options : undefined
        )
      }
    }
  }),
  defineMethod({
    name: 'terminal.isRunningAgent',
    permission: 'workspace',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      isRunningAgent: await runtime.isTerminalRunningAgent(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.agentStatus',
    permission: 'workspace',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      agentStatus: await runtime.getTerminalAgentStatus(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.rename',
    permission: 'workspace',
    params: TerminalRename,
    handler: async (params, { runtime }) => ({
      rename: await runtime.renameTerminal(params.terminal, params.title || null)
    })
  }),
  defineMethod({
    name: 'terminal.clearBuffer',
    permission: 'workspace',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      clear: await runtime.clearTerminalBuffer(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.resetInputModes',
    permission: 'workspace',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      reset: await runtime.resetTerminalInputModes(params.terminal)
    })
  })
]
