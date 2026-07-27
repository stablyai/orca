import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildClaudeAgentTeamsLaunchPlan,
  ensureClaudeAgentTeamsShimDir,
  resolveClaudeAgentTeamsShimBin
} from './claude-agent-teams-shim-env'

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

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
        envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
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

  describe('windows tmux.exe shim installation', () => {
    const originalPlatform = process.platform
    const originalResourcesPath = process.resourcesPath

    afterEach(() => {
      setProcessProp('platform', originalPlatform)
      setProcessProp('resourcesPath', originalResourcesPath)
    })

    it('copies the bundled tmux shim into the shim dir', async () => {
      setProcessProp('platform', 'win32')
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)
      // Create a fake bundled tmux source
      const fakeResources = await mkdtemp(join(tmpdir(), 'orca-fake-resources-'))
      roots.push(fakeResources)
      const fakeBundledSource = join(fakeResources, 'bin', 'agent-teams', 'tmux.exe')
      await mkdir(join(fakeResources, 'bin', 'agent-teams'), { recursive: true })
      await writeFile(fakeBundledSource, 'TMUX-EXE-BYTES')
      setProcessProp('resourcesPath', fakeResources)

      await ensureClaudeAgentTeamsShimDir(root)

      await expect(readFile(join(root, 'tmux.exe'), 'utf8')).resolves.toBe('TMUX-EXE-BYTES')
      await expect(readFile(join(root, 'tmux'), 'utf8')).resolves.toContain('agent-teams-tmux')
      await expect(readFile(join(root, 'tmux.cmd'), 'utf8')).resolves.toContain('agent-teams-tmux')
    })

    it('tolerates a missing bundled shim', async () => {
      setProcessProp('platform', 'win32')
      setProcessProp('resourcesPath', '/nonexistent/path')
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)

      // Should not throw
      await ensureClaudeAgentTeamsShimDir(root)

      // tmux and tmux.cmd should still exist
      await expect(readFile(join(root, 'tmux'), 'utf8')).resolves.toContain('agent-teams-tmux')
      await expect(readFile(join(root, 'tmux.cmd'), 'utf8')).resolves.toContain('agent-teams-tmux')
      // tmux.exe should not exist
      await expect(stat(join(root, 'tmux.exe'))).rejects.toThrow()
    })

    it('does not rewrite an unchanged shim', async () => {
      setProcessProp('platform', 'win32')
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)
      // Create a fake bundled tmux source
      const fakeResources = await mkdtemp(join(tmpdir(), 'orca-fake-resources-'))
      roots.push(fakeResources)
      const fakeBundledSource = join(fakeResources, 'bin', 'agent-teams', 'tmux.exe')
      await mkdir(join(fakeResources, 'bin', 'agent-teams'), { recursive: true })
      await writeFile(fakeBundledSource, 'TMUX-EXE-BYTES')
      setProcessProp('resourcesPath', fakeResources)

      // First run
      await ensureClaudeAgentTeamsShimDir(root)
      const firstMtime = (await stat(join(root, 'tmux.exe'))).mtimeMs

      // Advance time slightly and run again
      await new Promise((r) => setTimeout(r, 10))
      await ensureClaudeAgentTeamsShimDir(root)
      const secondMtime = (await stat(join(root, 'tmux.exe'))).mtimeMs

      expect(secondMtime).toBe(firstMtime)
    })

    it('copies nothing on non-Windows', async () => {
      setProcessProp('platform', 'darwin')
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-shim-'))
      roots.push(root)

      await ensureClaudeAgentTeamsShimDir(root)

      // Only tmux should exist
      await expect(readFile(join(root, 'tmux'), 'utf8')).resolves.toContain('agent-teams-tmux')
      await expect(stat(join(root, 'tmux.exe'))).rejects.toThrow()
      await expect(stat(join(root, 'tmux.cmd'))).rejects.toThrow()
    })
  })
})
