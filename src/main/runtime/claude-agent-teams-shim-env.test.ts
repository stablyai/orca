import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildClaudeAgentTeamsLaunchPlan,
  ensureClaudeAgentTeamsIt2ShimDir,
  ensureClaudeAgentTeamsShimDir,
  resolveClaudeAgentTeamsShimBin,
  windowsClaudeAgentTeamsShimScript
} from './claude-agent-teams-shim-env'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
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
    // Why: the plan writes its tmux shim under ~/.orca.
    vi.stubEnv('HOME', root)
    vi.stubEnv('USERPROFILE', root)
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

  it.skipIf(process.platform === 'win32')(
    'builds iTerm2 shim env only for an explicit iterm2 teammate mode',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
      roots.push(root)
      // Why: the plan writes its shims under ~/.orca.
      vi.stubEnv('HOME', root)
      const cliPath = join(root, 'orca-dev')
      await writeFile(cliPath, '#!/usr/bin/env sh\n', 'utf8')
      await chmod(cliPath, 0o755)

      const seenIt2: unknown[] = []
      const build = (command: string, teammateMode?: 'iterm2') =>
        buildClaudeAgentTeamsLaunchPlan({
          command,
          mode: 'native-panes-shim',
          ...(teammateMode ? { teammateMode } : {}),
          baseEnv: { PATH: root },
          createTeamEnv: (_shimDir, _shimBin, it2) => {
            seenIt2.push(it2)
            return {}
          }
        })

      const iterm2 = await build("claude --teammate-mode iterm2 'hello'", 'iterm2')
      const auto = await build("claude --teammate-mode auto 'hello'")

      // Why: an explicit mode flag must survive untouched, never gain a competing `auto`.
      expect(iterm2?.command).toBe("claude --teammate-mode iterm2 'hello'")
      expect(auto?.command).toBe("claude --teammate-mode auto 'hello'")
      expect(seenIt2).toEqual([
        {
          shimDir: join(root, '.orca', 'claude-agent-teams-it2-bin'),
          probeShell: join(
            root,
            '.orca',
            'claude-agent-teams-it2-bin',
            'orca-agent-teams-probe-shell'
          )
        },
        undefined
      ])
    }
  )

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

describe('claude agent teams it2 shim', () => {
  it.skipIf(process.platform === 'win32')(
    'routes it2 to the Orca CLI only through a qualified shim bin',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-it2-'))
      roots.push(root)
      const shim = await ensureClaudeAgentTeamsIt2ShimDir(root)
      const cwd = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cwd-'))
      roots.push(cwd)
      const marker = join(cwd, 'hijacked')
      const decoy = join(cwd, 'orca')
      await writeFile(decoy, `#!/usr/bin/env sh\ntouch ${JSON.stringify(marker)}\n`, 'utf8')
      await chmod(decoy, 0o755)

      const it2 = join(shim?.shimDir ?? '', 'it2')
      const refused = spawnSync(it2, ['session', 'list'], {
        cwd,
        env: { PATH: `.:${process.env.PATH ?? ''}` },
        encoding: 'utf8'
      })

      expect(refused.status).toBe(127)
      expect(refused.stderr).toContain('orca agent-teams it2 shim')
      expect(existsSync(marker)).toBe(false)

      const cli = join(cwd, 'fake-orca')
      await writeFile(cli, '#!/usr/bin/env sh\necho "ran $*"\n', 'utf8')
      await chmod(cli, 0o755)
      const qualified = spawnSync(it2, ['session', 'list'], {
        cwd,
        env: { PATH: process.env.PATH ?? '', ORCA_AGENT_TEAMS_SHIM_BIN: cli },
        encoding: 'utf8'
      })

      expect(qualified.status).toBe(0)
      expect(qualified.stdout.trim()).toBe('ran agent-teams-it2 session list')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'probe shell answers only the it2 lookup and hands every other call to the real shell',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-it2-'))
      roots.push(root)
      const shim = await ensureClaudeAgentTeamsIt2ShimDir(root)
      const probeShell = shim?.probeShell ?? ''
      const realShell = join(root, 'real-shell')
      await writeFile(realShell, '#!/bin/sh\necho "real:$*"\n', 'utf8')
      await chmod(realShell, 0o755)
      const run = (args: string[], env: Record<string, string>) =>
        spawnSync(probeShell, args, {
          env: { PATH: process.env.PATH ?? '', ORCA_AGENT_TEAMS_REAL_SHELL: realShell, ...env },
          encoding: 'utf8',
          timeout: 5000
        })
      const lookup = ['-lc', 'command -v it2']

      expect(run(lookup, { ORCA_AGENT_TEAMS_IT2_SHIM_DIR: root }).stdout.trim()).toBe(
        join(root, 'it2')
      )
      expect(run(lookup, { ORCA_AGENT_TEAMS_IT2_SHIM_DIR: '' }).stdout.trim()).toBe(
        'real:-lc command -v it2'
      )
      expect(run([...lookup, 'extra'], { ORCA_AGENT_TEAMS_IT2_SHIM_DIR: root }).stdout.trim()).toBe(
        'real:-lc command -v it2 extra'
      )
      expect(run(['-c', 'echo hi'], { ORCA_AGENT_TEAMS_IT2_SHIM_DIR: root }).stdout.trim()).toBe(
        'real:-c echo hi'
      )

      // Why: a real shell that points back at the wrapper must not exec itself forever.
      const looped = run(['-c', 'echo ok'], { ORCA_AGENT_TEAMS_REAL_SHELL: probeShell })
      expect(looped.status).toBe(0)
      expect(looped.stdout.trim()).toBe('ok')
    }
  )
})
