import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedAgentHookTarget } from '../../../shared/managed-agent-hook-targets'
import { detectLocalManagedAgentCliPresence } from './local-agent-cli-presence'

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
