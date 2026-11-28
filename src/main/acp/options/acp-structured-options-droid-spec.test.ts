import { describe, expect, it } from 'vitest'
import { DROID_ACP_DIALECT } from '../acp-dialects/droid-dialect'
import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import { AcpStructuredOptions } from './acp-structured-options'

const permissionModes = { ask: 'normal', auto: 'auto-medium', 'full-access': 'auto-high' }

// Droid 1.17.2 reports Spec and its permission levels as one autonomy option.
function autonomy(currentValue: string): SessionConfigOption[] {
  return [
    {
      id: 'autonomy_level',
      name: 'Autonomy Level',
      category: 'mode',
      type: 'select',
      currentValue,
      options: ['normal', 'spec', 'auto-low', 'auto-medium', 'auto-high'].map((value) => ({
        value,
        name: value
      }))
    }
  ]
}

describe('AcpStructuredOptions with Droid Spec', () => {
  it('keeps the chat permission through Spec and builds at the level that ran before it', () => {
    const options = new AcpStructuredOptions(DROID_ACP_DIALECT)
    options.adoptSession({ configOptions: autonomy('auto-high') }, 'new')
    expect(options.write('interactionMode', 'plan')).toEqual({
      method: 'config',
      configId: 'autonomy_level',
      value: 'spec'
    })
    options.adoptConfigOptions(autonomy('spec'))
    expect(options.reportedPermissionMode(permissionModes)).toBe('full-access')
    expect(options.write('interactionMode', 'default')).toEqual({
      method: 'config',
      configId: 'autonomy_level',
      value: 'auto-high'
    })
  })
})
