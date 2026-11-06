import path from 'node:path'
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('runs vm recipe doctor locally without contacting the app runtime', async () => {
    const repoPath = mkdtempSync(path.join(tmpdir(), 'orca-vm-doctor-'))
    try {
      mkdirSync(path.join(repoPath, 'scripts', 'orca-vm'), { recursive: true })
      const startScript = path.join(repoPath, 'scripts', 'orca-vm', 'start.sh')
      const cleanupScript = path.join(repoPath, 'scripts', 'orca-vm', 'cleanup.sh')
      writeFileSync(startScript, '#!/bin/sh\n')
      writeFileSync(cleanupScript, '#!/bin/sh\n')
      chmodSync(startScript, 0o755)
      chmodSync(cleanupScript, 0o755)
      writeFileSync(
        path.join(repoPath, 'orca.yaml'),
        [
          'environmentRecipes:',
          '  - id: cloud-sandbox',
          '    name: Cloud Sandbox',
          '    create: ./scripts/orca-vm/start.sh',
          '    destroy: ./scripts/orca-vm/cleanup.sh'
        ].join('\n')
      )
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(['vm', 'recipe', 'doctor', 'cloud-sandbox', '--repo-path', repoPath, '--json'])

      const output = JSON.parse(String(logSpy.mock.calls[0][0])) as {
        ok: boolean
        checks: { id: string; status: string }[]
      }
      if (!output.ok) {
        throw new Error(JSON.stringify(output))
      }
      expect(output.ok).toBe(true)
      expect(output.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'orca_yaml.parse', status: 'pass' }),
          expect.objectContaining({ id: 'recipe.exists', status: 'pass' }),
          expect.objectContaining({ id: 'recipe.create', status: 'pass' }),
          expect.objectContaining({ id: 'recipe.destroy', status: 'pass' })
        ])
      )
      expect(callMock).not.toHaveBeenCalled()
    } finally {
      rmSync(repoPath, { recursive: true, force: true })
    }
  })
})
