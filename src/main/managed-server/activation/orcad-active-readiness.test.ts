import { describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import type { OrcadHostTransport } from '../install/orcad-host-transport'
import { probeActiveOrcadReadiness } from './orcad-active-readiness'

const probe = () =>
  probeActiveOrcadReadiness(
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked, so the transport is never used.
      conn: Object.create(null) as OrcadHostTransport,
      host: getRemoteHostPlatform('linux-x64'),
      remoteInstallDir: '/home/u/.orca-remote/orcad-0.1.0+aa'
    },
    { buildHash: 'abc123def4567890', fullVersion: '0.1.0+aa' }
  )

describe('probeActiveOrcadReadiness on a POSIX host', () => {
  // Only a proven exit may restart or replace a slot; a reply of any other shape proves nothing.
  it('reports a dead slot as exited and a reply of another shape as unverifiable', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('DEAD\n\n__ORCA_ACTIVE_PROBE_END__\n')
    await expect(probe()).rejects.toMatchObject({ verdict: 'exited' })
    vi.mocked(execCommand).mockResolvedValueOnce('DEAD\n')
    await expect(probe()).rejects.toMatchObject({ verdict: 'unverifiable' })
  })
})
