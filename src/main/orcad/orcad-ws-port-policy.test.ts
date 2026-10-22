import { describe, expect, it } from 'vitest'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'
import { orcadWsPortOptions } from './orcad-ws-port-policy'

describe('orcadWsPortOptions', () => {
  it('leaves the default port and its fallback alone without --port', () => {
    expect(orcadWsPortOptions(undefined, {})).toEqual({})
  })

  it('requires an operator --port', () => {
    expect(orcadWsPortOptions(7001, {})).toEqual({
      wsPort: 7001,
      preferPinnedWsPort: true,
      requirePinnedWsPort: true
    })
  })

  it('lets a managed launch fall back when its port is taken', () => {
    expect(
      orcadWsPortOptions(6768, { [ORCAD_MANAGED_ACTIVATION_ROOT_ENV]: '/home/u/.orca-remote' })
    ).toEqual({ wsPort: 6768, preferPinnedWsPort: true })
  })
})
