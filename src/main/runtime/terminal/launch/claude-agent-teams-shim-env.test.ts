import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ensureClaudeAgentTeamsShimDir } from './claude-agent-teams-shim-env'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

describe('claude agent teams shim env', () => {
  it.skipIf(process.platform === 'win32')(
    'never runs a cwd-resolved orca when the shim bin is unqualified',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)
      await ensureClaudeAgentTeamsShimDir(root)
      const cwd = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cwd-'))
      roots.push(cwd)
      const marker = join(cwd, 'hijacked')
      for (const name of ['orca', 'orca-ide']) {
        const decoy = join(cwd, name)
        await writeFile(decoy, `#!/usr/bin/env sh\ntouch ${JSON.stringify(marker)}\n`, 'utf8')
        await chmod(decoy, 0o755)
      }

      const hijack = spawnSync(join(root, 'tmux'), ['display-message', '-p', '#{pane_id}'], {
        cwd,
        env: { PATH: `.:${process.env.PATH ?? ''}` },
        encoding: 'utf8'
      })

      expect(hijack.status).toBe(127)
      expect(hijack.stderr).toContain('absolute path')
      expect(existsSync(marker)).toBe(false)

      const cli = join(cwd, 'fake-orca')
      await writeFile(cli, '#!/usr/bin/env sh\necho "ran $*"\n', 'utf8')
      await chmod(cli, 0o755)
      const qualified = spawnSync(join(root, 'tmux'), ['list-panes'], {
        cwd,
        env: { PATH: `.:${process.env.PATH ?? ''}`, ORCA_AGENT_TEAMS_SHIM_BIN: cli },
        encoding: 'utf8'
      })

      expect(qualified.status).toBe(0)
      expect(qualified.stdout.trim()).toBe('ran agent-teams-tmux list-panes')
    }
  )
})
