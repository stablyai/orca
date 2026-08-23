import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildClaudeAgentTeamsLaunchPlan,
  ensureClaudeAgentTeamsShimDir,
  prepareClaudeAgentTeamsShimTarget,
  resolveClaudeAgentTeamsShimBin,
  windowsClaudeAgentTeamsShimScript,
  windowsClaudeAgentTeamsVersionedShimRoot
} from './claude-agent-teams-shim-env'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
  vi.unstubAllEnvs()
})

describe('claude agent teams shim env', () => {
  it('isolates Windows launcher versions so a running shim is never overwritten', () => {
    const root = 'C:\\shim-root'
    expect(windowsClaudeAgentTeamsVersionedShimRoot(root, Buffer.from('old'))).not.toBe(
      windowsClaudeAgentTeamsVersionedShimRoot(root, Buffer.from('new'))
    )
  })

  it.skipIf(process.platform !== 'win32')(
    'installs the exact launcher bytes used to select the versioned directory',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-versioned-shim-'))
      roots.push(root)
      const launcher = Buffer.from('versioned launcher fixture')

      await ensureClaudeAgentTeamsShimDir(root, launcher)

      await expect(readFile(join(root, 'tmux.exe'))).resolves.toEqual(launcher)
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'selects and installs a versioned shim from one launcher read',
    async () => {
      const repoRoot = await mkdtemp(join(tmpdir(), 'orca-agent-teams-launcher-source-'))
      const shimRoot = await mkdtemp(join(tmpdir(), 'orca-agent-teams-versioned-target-'))
      roots.push(repoRoot, shimRoot)
      const launcherPath = join(repoRoot, 'native', 'windows-cli-launcher', '.build', 'orca.exe')
      await mkdir(join(repoRoot, 'native', 'windows-cli-launcher', '.build'), { recursive: true })
      await writeFile(launcherPath, 'source fixture', 'utf8')
      vi.stubEnv('ORCA_DEV_REPO_ROOT', repoRoot)
      const first = Buffer.from('first launcher bytes')
      const readWindowsLauncher = vi
        .fn<(path: string) => Promise<Buffer>>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(Buffer.from('changed launcher bytes'))

      const target = await prepareClaudeAgentTeamsShimTarget(
        { ORCA_AGENT_TEAMS_SHIM_BIN: process.execPath },
        shimRoot,
        readWindowsLauncher
      )

      expect(readWindowsLauncher).toHaveBeenCalledTimes(1)
      expect(readWindowsLauncher).toHaveBeenCalledWith(launcherPath)
      expect(target?.shimDir).toBe(windowsClaudeAgentTeamsVersionedShimRoot(shimRoot, first))
      await expect(readFile(join(target!.shimDir, 'tmux.exe'))).resolves.toEqual(first)
    }
  )

  it('writes a private tmux shim that calls the Orca shim command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
    roots.push(root)

    await ensureClaudeAgentTeamsShimDir(root)

    await expect(readFile(join(root, 'tmux'), 'utf8')).resolves.toContain('agent-teams-tmux "$@"')
  })

  it('builds native shim env only where pre-spawn shell authority is sufficient', async () => {
    if (process.platform === 'win32') {
      vi.stubEnv('ORCA_DEV_REPO_ROOT', process.cwd())
    }
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cli-'))
    roots.push(root)
    const cliName = process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev'
    const cliPath = join(root, cliName)
    await writeFile(cliPath, '#!/usr/bin/env sh\n', 'utf8')
    if (process.platform === 'win32') {
      await writeFile(join(root, 'tmux.exe'), 'fixture', 'utf8')
    }
    if (process.platform !== 'win32') {
      await chmod(cliPath, 0o755)
    }

    let capturedShimBin = ''
    const plan = await buildClaudeAgentTeamsLaunchPlan({
      command: "claude 'hello'",
      mode: 'native-panes-shim',
      paneShell: process.platform === 'win32' ? 'powershell' : undefined,
      executionPlatform: process.platform,
      isRemote: false,
      baseEnv: {
        PATH: root,
        ...(process.platform === 'win32' ? { ORCA_AGENT_TEAMS_SHIM_BIN: process.execPath } : {})
      },
      shimRoot: root,
      createTeamEnv: (shimDir, shimBin, shimEnv) => {
        capturedShimBin = shimBin
        return {
          PATH: `${shimDir}:/usr/bin`,
          TMUX: '/tmp/orca/fake,0,0',
          TMUX_PANE: '%1',
          ...shimEnv
        }
      }
    })

    if (process.platform === 'win32') {
      expect(plan).toEqual({
        mode: 'in-process',
        command: "claude --teammate-mode in-process 'hello'",
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
      })
      expect(capturedShimBin).toBe('')
    } else {
      expect(plan).toMatchObject({
        mode: 'native',
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
        executionPlatform: process.platform,
        isRemote: false,
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
        executionPlatform: process.platform,
        isRemote: false,
        baseEnv: { PATH: '.' },
        createTeamEnv
      })
    ).resolves.toEqual({
      mode: 'in-process',
      command: 'claude --teammate-mode in-process',
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
    })
  })

  it.skipIf(process.platform !== 'win32')(
    'falls back to in-process teammates for cmd panes',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-cmd-'))
      roots.push(root)
      const cliPath = join(root, process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev')
      await writeFile(cliPath, '', 'utf8')

      await expect(
        buildClaudeAgentTeamsLaunchPlan({
          command: 'claude',
          mode: 'native-panes-shim',
          paneShell: 'cmd',
          executionPlatform: 'win32',
          isRemote: false,
          baseEnv: { PATH: root },
          createTeamEnv: () => {
            throw new Error('cmd must not build native shim env')
          }
        })
      ).resolves.toEqual({
        mode: 'in-process',
        command: 'claude --teammate-mode in-process',
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
      })
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'keeps unproved Windows execution topologies in-process',
    async () => {
      const createTeamEnv = (): Record<string, string> => {
        throw new Error('unproved topology must not build native shim env')
      }
      for (const topology of [
        { executionPlatform: 'linux' as const, isRemote: false, paneShell: undefined },
        { executionPlatform: 'win32' as const, isRemote: true, paneShell: undefined },
        { executionPlatform: 'win32' as const, isRemote: false, paneShell: 'posix' as const },
        { executionPlatform: 'win32' as const, isRemote: false, paneShell: 'cmd' as const }
      ]) {
        await expect(
          buildClaudeAgentTeamsLaunchPlan({
            command: 'claude',
            mode: 'native-panes-shim',
            baseEnv: {},
            createTeamEnv,
            ...topology
          })
        ).resolves.toEqual({
          mode: 'in-process',
          command: 'claude --teammate-mode in-process',
          env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
        })
      }
    }
  )

  it('materializes one shim directory under concurrent launches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-concurrent-'))
    roots.push(root)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_787_483_000_000)
    try {
      await expect(
        Promise.all(Array.from({ length: 16 }, () => ensureClaudeAgentTeamsShimDir(root)))
      ).resolves.toHaveLength(16)
    } finally {
      now.mockRestore()
    }
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
