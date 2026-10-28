import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const nodePty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => nodePty)

import { loadLocalPtyRuntimeSpawn } from './local-pty-runtime-spawn'

// A real file named wsl: the spawn path validates the shell before handing it to node-pty.
const WSL = join(mkdtempSync(join(tmpdir(), 'orca-wsl-allowlist-')), 'wsl')
writeFileSync(WSL, '#!/bin/sh\n')
chmodSync(WSL, 0o755)

function params(shellArgs: string[]) {
  return { shellPath: WSL, shellArgs, cols: 80, rows: 24, cwd: '/tmp', env: {} }
}

describe.skipIf(process.platform === 'win32')(
  'degraded local PTY spawn under the internal WSL distro allowlist',
  () => {
    afterEach(() => {
      vi.unstubAllEnvs()
      nodePty.spawn.mockReset()
    })

    it('never starts a pane in an excluded distro, and still starts one in an allowed distro', async () => {
      vi.stubEnv('ORCA_INTERNAL_WSL_DISTRO_ALLOWLIST', 'orca-test-a')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const pane = { pid: 1 }
      nodePty.spawn.mockReturnValue(pane)
      const spawn = await loadLocalPtyRuntimeSpawn()

      // The refused primary takes the existing shell fallback path; wsl.exe never reaches node-pty.
      try {
        await spawn(params(['-d', 'Ubuntu']))
      } catch {
        // No fallback shell on this host is also a refusal.
      }
      expect(nodePty.spawn.mock.calls.filter(([file]) => file === WSL)).toEqual([])

      expect(await spawn(params(['-d', 'orca-test-a']))).toMatchObject({ process: pane })
      expect(nodePty.spawn).toHaveBeenLastCalledWith(WSL, ['-d', 'orca-test-a'], expect.anything())
    })

    it('starts any distro when the allowlist is unset', async () => {
      const pane = { pid: 2 }
      nodePty.spawn.mockReturnValue(pane)
      const spawn = await loadLocalPtyRuntimeSpawn()
      expect(await spawn(params(['-d', 'Ubuntu']))).toMatchObject({ process: pane })
      expect(nodePty.spawn).toHaveBeenCalledWith(WSL, ['-d', 'Ubuntu'], expect.anything())
    })
  }
)
