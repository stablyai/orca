import { defineMethod } from '../../core'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../../ai-vault/structured-session-ownership'
import {
  TerminalSubmitPrompt,
  TerminalWaitPrompt
} from '../../../../../shared/rpc-contract/terminal-unary-params'
import {
  assertTerminalSendTextWithinLimit,
  commitMobileInputFloorClaim,
  createTerminalAgentSendGuard,
  resolveMobileFloorClientId,
  type MobileInputFloorClaimHolder
} from './terminal-input-delivery'

export const TERMINAL_PROMPT_SUBMISSION_METHODS = [
  defineMethod({
    name: 'terminal.submitPrompt',
    permission: 'workspace',
    params: TerminalSubmitPrompt,
    handler: async (params, { runtime }) => {
      await assertTerminalSendTextWithinLimit(params.prompt)
      await assertLegacyAiVaultResumeCommandAllowed(params.prompt, () =>
        runtime.ensureStructuredAgentSessionHost()
      )
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      const driver = leaf?.ptyId ? runtime.getDriver(leaf.ptyId) : null
      const mobileClientId = resolveMobileFloorClientId(driver, params.client)
      const floorClaim: MobileInputFloorClaimHolder = { current: null }
      return {
        submission: await runtime.queueTerminalAgentPrompt(
          params.terminal,
          params.requestId,
          params.prompt,
          {
            inputKind: 'driving',
            beforeWrite: createTerminalAgentSendGuard(runtime, params.terminal, params.client),
            ...(mobileClientId
              ? {
                  reserveWrite: (ptyId: string) => {
                    const claim = runtime.beginMobileInputFloor(ptyId, mobileClientId)
                    if (!claim) {
                      throw new Error('mobile_input_floor_unavailable')
                    }
                    floorClaim.current = claim
                  },
                  afterWrite: () => commitMobileInputFloorClaim(floorClaim),
                  onSettled: () => floorClaim.current?.rollback()
                }
              : {})
          }
        )
      }
    }
  }),
  defineMethod({
    name: 'terminal.waitPrompt',
    permission: 'workspace',
    params: TerminalWaitPrompt,
    handler: async (params, { runtime, signal }) => ({
      submission: await runtime.waitForTerminalAgentPrompt(
        params.terminal,
        params.requestId,
        params.timeoutMs,
        signal
      )
    })
  })
]
