import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedAgentHookTarget } from '../../../shared/managed-agent-hook-targets'
import {
  detectLocalManagedAgentCliPresence,
  resolveLocalAgentCommand
} from './local-agent-cli-presence'

const { mergePersistedWindowsPathAsyncMock } = vi.hoisted(() => ({
  mergePersistedWindowsPathAsyncMock: vi.fn(async (_env: NodeJS.ProcessEnv) => undefined)
}))
vi.mock('../../pty/environment/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: mergePersistedWindowsPathAsyncMock
}))

const codexTarget: ManagedAgentHookTarget = {
  agent: 'codex',
  tuiAgent: 'codex',
  executableCandidates: ['codex']
}

const claudeTarget: ManagedAgentHookTarget = {
  agent: 'claude',
  tuiAgent: 'claude',
  executableCandidates: ['claude']
}

describe('detectLocalManagedAgentCliPresence', () => {
  let tmpDir: string | null = null

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  })

  it.runIf(process.platform !== 'win32')(
    'accepts executable symlinks and rejects broken symlinks',
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'orca-cli-presence-'))
      const binDir = join(tmpDir, 'bin')
      mkdirSync(binDir)
      const targetPath = join(tmpDir, 'codex-real')
      writeFileSync(targetPath, '#!/bin/sh\n')
      chmodSync(targetPath, 0o755)
      symlinkSync(targetPath, join(binDir, 'codex'))
      symlinkSync(join(tmpDir, 'missing'), join(binDir, 'claude'))

      const result = await detectLocalManagedAgentCliPresence(
        [codexTarget, claudeTarget],
        { agentCmdOverrides: {} },
        { pathEnv: binDir, pathDelimiter: ':', platform: process.platform }
      )

      expect(result.codex?.state).toBe('found')
      expect(result.claude?.state).toBe('missing')
    }
  )
})

describe('resolveLocalAgentCommand', () => {
  const linux = { pathDelimiter: ':', platform: 'linux' as const, homeDir: '/home/orca' }

  it('expands a home-relative override the way presence does', async () => {
    const probe = vi.fn(async (filePath: string) => filePath === '/home/orca/bin/bob')
    const resolved = await resolveLocalAgentCommand('~/bin/bob', {
      ...linux,
      pathEnv: '',
      fileProbe: { isExecutableFile: probe }
    })
    expect(resolved).toBe('/home/orca/bin/bob')
  })

  it('keeps a match from a relative PATH entry', async () => {
    const probe = vi.fn(async (filePath: string) => filePath === 'node_modules/.bin/bob')
    const resolved = await resolveLocalAgentCommand('bob', {
      ...linux,
      pathEnv: 'node_modules/.bin:/usr/bin',
      fileProbe: { isExecutableFile: probe }
    })
    expect(resolved).toBe('node_modules/.bin/bob')
  })

  it('rejects a relative path-shaped command', async () => {
    const probe = vi.fn(async () => true)
    const resolved = await resolveLocalAgentCommand('bin/bob', {
      ...linux,
      pathEnv: '',
      fileProbe: { isExecutableFile: probe }
    })
    expect(resolved).toBeNull()
  })
})
