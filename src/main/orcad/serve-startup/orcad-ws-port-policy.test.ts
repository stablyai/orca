import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readWsFallbackPort,
  writeWsFallbackPort
} from '../../runtime/rpc/transports/websocket/ws-fallback-port-store'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../../shared/remote-runtime/serve-supervisor/orcad-managed-launch-env'
import { clearDesktopRuntimeFallbackPort, orcadWsPortOptions } from './orcad-ws-port-policy'

const managed = { [ORCAD_MANAGED_ACTIVATION_ROOT_ENV]: '/home/me/.orca-remote' }

describe('orcadWsPortOptions', () => {
  it('moves a managed orcad off the desktop runtime port and its fallback ladder', () => {
    expect(orcadWsPortOptions(6768, managed)).toEqual({ wsPort: 6800, preferPinnedWsPort: true })
    expect(orcadWsPortOptions(6770, managed)).toEqual({ wsPort: 6800, preferPinnedWsPort: true })
    expect(orcadWsPortOptions(6799, managed)).toEqual({ wsPort: 6800, preferPinnedWsPort: true })
    expect(orcadWsPortOptions(6805, managed)).toEqual({ wsPort: 6805, preferPinnedWsPort: true })
  })

  it('drops a saved fallback in the desktop range for managed launches only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orcad-fallback-port-'))
    try {
      writeWsFallbackPort(dir, 6770)
      clearDesktopRuntimeFallbackPort(dir, {})
      expect(readWsFallbackPort(dir)).toBe(6770)
      clearDesktopRuntimeFallbackPort(dir, managed)
      expect(readWsFallbackPort(dir)).toBeUndefined()
      writeWsFallbackPort(dir, 6801)
      clearDesktopRuntimeFallbackPort(dir, managed)
      expect(readWsFallbackPort(dir)).toBe(6801)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
