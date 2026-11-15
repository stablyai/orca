import { describe, expect, it } from 'vitest'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../../shared/remote-runtime/serve-supervisor/orcad-managed-launch-env'
import { orcadWsPortOptions } from './orcad-ws-port-policy'

const managed = { [ORCAD_MANAGED_ACTIVATION_ROOT_ENV]: '/home/me/.orca-remote' }

describe('orcadWsPortOptions', () => {
  it('moves a managed orcad off the desktop runtime port and its fallback ladder', () => {
    expect(orcadWsPortOptions(6768, managed)).toEqual({ wsPort: 6800, preferPinnedWsPort: true })
    expect(orcadWsPortOptions(6770, managed)).toEqual({ wsPort: 6800, preferPinnedWsPort: true })
    expect(orcadWsPortOptions(6799, managed)).toEqual({ wsPort: 6800, preferPinnedWsPort: true })
    expect(orcadWsPortOptions(6805, managed)).toEqual({ wsPort: 6805, preferPinnedWsPort: true })
  })
})
