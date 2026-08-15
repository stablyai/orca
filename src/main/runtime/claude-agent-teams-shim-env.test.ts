import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildClaudeAgentTeamsLaunchPlan,
  ensureClaudeAgentTeamsShimDir,
  resolveClaudeAgentTeamsShimBin,
  windowsClaudeAgentTeamsShimScript
} from './claude-agent-teams-shim-env'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

describe('claude agent teams shim env', () => {
  it('writes a private tmux shim that calls the Orca shim command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
    roots.push(root)

    await ensureClaudeAgentTeamsShimDir(root)

    await expect(readFile(join(root, 'tmux'), 'utf8')).resolves.toContain('agent-teams-tmux "$@"')
  })

  it('builds native shim env only for direct Claude commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
    roots.push(root)
    const cliName = process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev'
    const cliPath = join(root, cliName)
    await writeFile(cliPath, '#!/usr/bin/env sh\n', 'utf8')
    if (process.platform !== 'win32') {
      await chmod(cliPath, 0o755)
    }

    let capturedShimBin = ''
    const plan = await buildClaudeAgentTeamsLaunchPlan({
      command: "claude 'hello'",
      mode: 'native-panes-shim',
      baseEnv: { PATH: root },
      createTeamEnv: (shimDir, shimBin) => {
        capturedShimBin = shimBin
        return {
          PATH: `${shimDir}:/usr/bin`,
          TMUX: '/tmp/orca/fake,0,0',
          TMUX_PANE: '%1'
        }
      }
    })

    if (process.platform === 'win32') {
      expect(plan).toMatchObject({
        command: "claude --teammate-mode in-process 'hello'",
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
      })
      expect(plan?.envToDelete).toBeUndefined()
      expect(capturedShimBin).toBe('')
    } else {
      expect(plan).toMatchObject({
        command: "claude --teammate-mode auto 'hello'",
        env: expect.objectContaining({ TMUX_PANE: '%1' }),
        envToDelete: ['TERM_PROGRAM']
      })
      expect(capturedShimBin).toBe(cliPath)
    }

    await expect(
      buildClaudeAgentTeamsLaunchPlan({
        command: "echo ok; claude 'hello'",
        mode: 'native-panes-shim',
        baseEnv: {},
        createTeamEnv: () => ({})
      })
    ).resolves.toBeNull()
  })

  it('resolves the dev CLI wrapper for the tmux callback binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
    roots.push(root)
    const cliName = process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev'
    const cliPath = join(root, cliName)
    await writeFile(cliPath, '#!/usr/bin/env sh\n', 'utf8')
    if (process.platform !== 'win32') {
      await chmod(cliPath, 0o755)
    }

    expect(resolveClaudeAgentTeamsShimBin({ PATH: root })).toBe(cliPath)
  })

  it('refuses to resolve a CLI through relative PATH entries or a bare override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
    roots.push(root)
    for (const name of ['orca', 'orca-ide', 'orca.cmd']) {
      const path = join(root, name)
      await writeFile(path, '#!/usr/bin/env sh\n', 'utf8')
      if (process.platform !== 'win32') {
        await chmod(path, 0o755)
      }
    }

    expect(resolveClaudeAgentTeamsShimBin({ PATH: '.' })).toBeNull()
    expect(resolveClaudeAgentTeamsShimBin({ PATH: '' })).toBeNull()
    expect(
      resolveClaudeAgentTeamsShimBin({ PATH: '.', ORCA_AGENT_TEAMS_SHIM_BIN: 'orca' })
    ).toBeNull()
    // Why: a bare override is still honored when it maps to a real absolute PATH entry.
    expect(resolveClaudeAgentTeamsShimBin({ PATH: root, ORCA_AGENT_TEAMS_SHIM_BIN: 'orca' })).toBe(
      join(root, 'orca')
    )
  })

  it.skipIf(process.platform !== 'win32')(
    'resolves through the Windows `Path` env spelling',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
      roots.push(root)
      const cliPath = join(root, 'orca.cmd')
      await writeFile(cliPath, '@echo off\r\n', 'utf8')

      expect(resolveClaudeAgentTeamsShimBin({ Path: root })).toBe(cliPath)
    }
  )

  it('falls back to in-process teammates when no absolute CLI can be qualified', async () => {
    const createTeamEnv = (): Record<string, string> => {
      throw new Error('native shim env must not be built without a qualified CLI')
    }

    await expect(
      buildClaudeAgentTeamsLaunchPlan({
        command: 'claude',
        mode: 'native-panes-shim',
        baseEnv: { PATH: '.' },
        createTeamEnv
      })
    ).resolves.toEqual({
      command: 'claude --teammate-mode in-process',
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
    })
  })

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

  it('writes a Windows shim that rejects an unqualified shim bin', () => {
    const script = windowsClaudeAgentTeamsShimScript()

    expect(script).not.toMatch(/^set "ORCA_AGENT_TEAMS_SHIM_BIN=orca/m)
    expect(script).toContain('if "%ORCA_SHIM_BIN:~1,1%"==":" goto :run')
    // Why: `call` would re-expand `%2`-style tmux pane args as batch parameters.
    expect(script).toContain('\r\n"%ORCA_SHIM_BIN%" agent-teams-tmux %*\r\n')
    expect(script).toContain('exit /b 127')
  })
})
