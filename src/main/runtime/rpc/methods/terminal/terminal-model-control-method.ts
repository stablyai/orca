import { defineMethod } from '../../core'
import { TerminalModelControlParams } from '../../../../../shared/rpc-contract/terminal-model-control-params'
import {
  terminalInputSourceForClient,
  commitMobileInputFloorClaim,
  type MobileInputFloorClaimHolder
} from './terminal-input-delivery'

export const TERMINAL_MODEL_CONTROL_METHODS = [
  defineMethod({
    name: 'terminal.model-control',
    permission: 'workspace',
    params: TerminalModelControlParams,
    handler: async (params, { runtime, caller }) => {
      const claim: MobileInputFloorClaimHolder = { current: null }
      try {
        const control = await runtime.controlTerminalModel(params.terminal, params, {
          expectedIncarnationId: params.expectedIncarnationId,
          inputSource: terminalInputSourceForClient(params.client, caller),
          ...(params.client.type === 'mobile'
            ? {
                beforeWrite: (ptyId: string) => {
                  const reserved = runtime.beginMobileInputFloor(ptyId, params.client.id)
                  if (!reserved) {
                    throw new Error('mobile_input_floor_unavailable')
                  }
                  claim.current = reserved
                },
                afterWrite: () => commitMobileInputFloorClaim(claim)
              }
            : {})
        })
        return { control }
      } finally {
        claim.current?.rollback()
      }
    }
  })
]
