import { defineMethod, type RpcMethod } from '../core'
import { ForkCreate, ForkList, ForkPreflight, ForkRemove, ForkSelector } from './fork-schemas'
import type { TuiAgent } from '../../../../shared/types'

export const FORK_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'fork.preflight',
    params: ForkPreflight,
    handler: async (params, { runtime }) =>
      runtime.preflightAgentSessionFork({
        terminalHandle: params.terminal,
        worktreeSelector: params.worktree,
        agent: params.agent as TuiAgent | undefined,
        providerSession: params.providerSession,
        promptInteractions: params.promptInteractions,
        forkPoint: params.message ? { kind: 'message', id: params.message } : undefined,
        noCopyFiles: params.noCopyFiles === true
      })
  }),
  defineMethod({
    name: 'fork.create',
    params: ForkCreate,
    handler: async (params, { runtime }) =>
      runtime.createAgentSessionFork({
        terminalHandle: params.terminal,
        worktreeSelector: params.worktree,
        agent: params.agent as TuiAgent | undefined,
        providerSession: params.providerSession,
        promptInteractions: params.promptInteractions,
        forkPoint: params.message ? { kind: 'message', id: params.message } : undefined,
        name: params.name,
        activate: params.activate,
        noCopyFiles: params.noCopyFiles === true
      })
  }),
  defineMethod({
    name: 'fork.list',
    params: ForkList,
    handler: async (params, { runtime }) =>
      runtime.listAgentSessionForks({
        worktreeSelector: params.worktree,
        limit: params.limit
      })
  }),
  defineMethod({
    name: 'fork.show',
    params: ForkSelector,
    handler: async (params, { runtime }) => runtime.showAgentSessionFork(params.fork)
  }),
  defineMethod({
    name: 'fork.diff',
    params: ForkSelector,
    handler: async (params, { runtime }) => runtime.diffAgentSessionFork(params.fork)
  }),
  defineMethod({
    name: 'fork.rm',
    params: ForkRemove,
    handler: async (params, { runtime }) =>
      runtime.removeAgentSessionFork(params.fork, params.force === true, params.runHooks === true)
  })
]
