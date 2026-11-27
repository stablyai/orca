import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION
} from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { buildRuntimeRequestEnvelope } from './runtime-request-envelope'

describe('buildRuntimeRequestEnvelope', () => {
  it('sends a replay-only retry under the contract an older runtime refuses', () => {
    expect(
      buildRuntimeRequestEnvelope(
        'orchestration.send',
        { orchestrationReplayOnly: true },
        'req_1',
        {}
      )
    ).toMatchObject({
      orchestrationContractVersion: ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION,
      orchestrationRequestId: 'req_1'
    })
  })

  it('keeps the ordinary contract otherwise, and none outside orchestration', () => {
    expect(
      buildRuntimeRequestEnvelope('orchestration.send', undefined, 'req_1', {})
        .orchestrationContractVersion
    ).toBe(ORCHESTRATION_CONTRACT_VERSION)
    expect(
      buildRuntimeRequestEnvelope('status.get', { orchestrationReplayOnly: true }, undefined, {})
        .orchestrationContractVersion
    ).toBeUndefined()
  })
})
