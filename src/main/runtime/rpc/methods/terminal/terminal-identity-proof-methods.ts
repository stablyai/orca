import { defineMethod, type RpcAnyMethod } from '../../core'
import { TerminalIdentityProofBegin, TerminalIdentityProofComplete } from './unary-schemas'

export const TERMINAL_IDENTITY_PROOF_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.identityProof.begin',
    params: TerminalIdentityProofBegin,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => ({
      proof: await runtime.beginTerminalIdentityProof(
        params.worktree,
        authenticatedCallerFingerprint
      )
    })
  }),
  defineMethod({
    name: 'terminal.identityProof.complete',
    params: TerminalIdentityProofComplete,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => ({
      proof: await runtime.completeTerminalIdentityProof(
        params.challengeId,
        params.title,
        authenticatedCallerFingerprint
      )
    })
  })
]
