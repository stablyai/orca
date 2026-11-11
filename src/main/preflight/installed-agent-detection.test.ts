import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/command-path/agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: vi.fn()
}))

import { detectInstalledAgents } from './installed-agent-detection'

describe('detectInstalledAgents command overrides', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orca agent override '))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists an agent outside PATH only when its override executable exists', async () => {
    const executable = path.join(dir, process.platform === 'win32' ? 'ante.exe' : 'ante')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o755)

    await expect(
      detectInstalledAgents(undefined, { agentCmdOverrides: { ante: `"${executable}"` } })
    ).resolves.toContain('ante')
    await expect(
      detectInstalledAgents(undefined, {
        agentCmdOverrides: { ante: `"${path.join(dir, 'missing', 'ante')}"` }
      })
    ).resolves.not.toContain('ante')
  })
})
