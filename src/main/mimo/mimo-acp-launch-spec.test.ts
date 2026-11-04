import { describe, expect, it } from 'vitest'
import { MIMO_LAUNCH_SPEC } from './mimo-acp-launch-spec'

describe('MiMo ACP model listing', () => {
  it('does not expose model details that its session catalog merge cannot retain', () => {
    const discovery = MIMO_LAUNCH_SPEC.modelDiscovery
    if (discovery?.kind !== 'command') {
      throw new Error('MiMo model discovery must be a command')
    }

    const [model] = discovery.parse(
      'provider/model\n{"providerID":"provider","limit":{"context":128000,"output":8192},"capabilities":{"reasoning":true}}'
    )

    expect(model?.details).toBeUndefined()
    expect(model?.efforts).toEqual([])
  })
})
