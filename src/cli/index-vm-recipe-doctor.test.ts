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
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../shared/pairing'
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

  it('warns when vm recipe doctor finds no cleanup hook', async () => {
    const repoPath = mkdtempSync(path.join(tmpdir(), 'orca-vm-doctor-'))
    try {
      mkdirSync(path.join(repoPath, 'scripts', 'orca-vm'), { recursive: true })
      writeFileSync(path.join(repoPath, 'scripts', 'orca-vm', 'start.sh'), '#!/bin/sh\n')
      writeFileSync(
        path.join(repoPath, 'orca.yaml'),
        [
          'environmentRecipes:',
          '  - id: manual-sandbox',
          '    name: Manual Sandbox',
          '    create: ./scripts/orca-vm/start.sh'
        ].join('\n')
      )
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(['vm', 'recipe', 'doctor', 'manual-sandbox', '--repo-path', repoPath, '--json'])

      const output = JSON.parse(String(logSpy.mock.calls[0][0])) as {
        ok: boolean
        checks: { id: string; status: string; remediation?: string }[]
      }
      if (!output.ok) {
        throw new Error(JSON.stringify(output))
      }
      expect(output.ok).toBe(true)
      expect(output.checks).toContainEqual(
        expect.objectContaining({
          id: 'recipe.destroy',
          status: 'warn',
          remediation: 'Add destroy or explicitly set destroy: none.'
        })
      )
    } finally {
      rmSync(repoPath, { recursive: true, force: true })
    }
  })

  it('runs vm recipe doctor provision mode and invokes cleanup', async () => {
    const repoPath = mkdtempSync(path.join(tmpdir(), 'orca-vm-doctor-provision-'))
    const pairingCode = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://sandbox.example.com:6767',
      deviceToken: 'token',
      publicKeyB64: 'public-key'
    })
    try {
      mkdirSync(path.join(repoPath, 'scripts', 'orca-vm'), { recursive: true })
      writeFileSync(
        path.join(repoPath, 'scripts', 'orca-vm', 'start.js'),
        [
          'console.log(JSON.stringify({',
          '  schemaVersion: 1,',
          `  pairingCode: ${JSON.stringify(pairingCode)},`,
          "  projectRoot: '/workspace/repo'",
          '}))'
        ].join('\n')
      )
      writeFileSync(
        path.join(repoPath, 'scripts', 'orca-vm', 'cleanup.js'),
        [
          "const fs = require('fs')",
          "const input = fs.readFileSync(0, 'utf8')",
          'const payload = JSON.parse(input)',
          "fs.writeFileSync('cleanup-ran.json', JSON.stringify(payload))"
        ].join('\n')
      )
      writeFileSync(
        path.join(repoPath, 'orca.yaml'),
        [
          'environmentRecipes:',
          '  - id: cloud-sandbox',
          '    name: Cloud Sandbox',
          `    create: ${JSON.stringify(`${process.execPath} ./scripts/orca-vm/start.js`)}`,
          `    destroy: ${JSON.stringify(`${process.execPath} ./scripts/orca-vm/cleanup.js`)}`
        ].join('\n')
      )
      const { EventEmitter } = await import('node:events')
      const startChild = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
        stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
        stdin: { write: vi.fn(), end: vi.fn() },
        kill: vi.fn()
      })
      const cleanupChild = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
        stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
        stdin: { write: vi.fn(), end: vi.fn() },
        kill: vi.fn()
      })
      spawnMock
        .mockImplementationOnce(() => {
          process.nextTick(() => {
            startChild.stdout.emit(
              'data',
              JSON.stringify({
                schemaVersion: 1,
                pairingCode,
                projectRoot: '/workspace/repo'
              })
            )
            startChild.emit('exit', 0, null)
            startChild.emit('close', 0, null)
          })
          return startChild
        })
        .mockImplementationOnce(() => {
          process.nextTick(() => {
            cleanupChild.emit('exit', 0, null)
            cleanupChild.emit('close', 0, null)
          })
          return cleanupChild
        })
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await main([
        'vm',
        'recipe',
        'doctor',
        'cloud-sandbox',
        '--repo-path',
        repoPath,
        '--provision',
        '--json'
      ])

      const output = JSON.parse(String(logSpy.mock.calls[0][0])) as {
        ok: boolean
        checks: { id: string; status: string }[]
        provisionTranscript?: {
          provision: { exitCode: number | null; stdout: string; stderr: string }
          destroy?: { exitCode: number | null; stdout: string; stderr: string }
        }
      }
      if (!output.ok) {
        throw new Error(JSON.stringify(output))
      }
      expect(output.ok).toBe(true)
      expect(output.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'recipe.provision', status: 'pass' }),
          expect.objectContaining({ id: 'recipe.result.endpoint.public_ws', status: 'warn' }),
          expect.objectContaining({ id: 'recipe.result.project_root', status: 'pass' }),
          expect.objectContaining({ id: 'recipe.destroy.run', status: 'pass' })
        ])
      )
      // The transcript carries both stages so the agent can self-diagnose.
      expect(output.provisionTranscript?.provision.exitCode).toBe(0)
      expect(output.provisionTranscript?.destroy?.exitCode).toBe(0)
      const cleanupPayload = JSON.parse(
        String(vi.mocked(cleanupChild.stdin.end).mock.calls[0]?.[0])
      ) as { recipeId: string; recipeResult: { projectRoot: string } }
      expect(cleanupPayload).toMatchObject({
        recipeId: 'cloud-sandbox',
        recipeResult: { projectRoot: '/workspace/repo' }
      })
    } finally {
      rmSync(repoPath, { recursive: true, force: true })
    }
  })

  it('returns the full create transcript when provision fails so the agent can self-diagnose', async () => {
    const repoPath = mkdtempSync(path.join(tmpdir(), 'orca-vm-doctor-provision-fail-'))
    try {
      mkdirSync(path.join(repoPath, 'scripts', 'orca-vm'), { recursive: true })
      writeFileSync(path.join(repoPath, 'scripts', 'orca-vm', 'start.js'), 'process.exit(0)')
      writeFileSync(
        path.join(repoPath, 'orca.yaml'),
        [
          'environmentRecipes:',
          '  - id: cloud-sandbox',
          '    name: Cloud Sandbox',
          `    create: ${JSON.stringify(`${process.execPath} ./scripts/orca-vm/start.js`)}`,
          '    destroy: none'
        ].join('\n')
      )
      const { EventEmitter } = await import('node:events')
      const startChild = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
        stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
        stdin: { write: vi.fn(), end: vi.fn() },
        kill: vi.fn()
      })
      // create emits a non-JSON line to stdout + a real diagnostic to stderr, then exits 0
      spawnMock.mockImplementationOnce(() => {
        process.nextTick(() => {
          startChild.stdout.emit('data', 'Provisioning sandbox...\n')
          startChild.stderr.emit('data', 'vercel: error: missing scope\n')
          startChild.emit('exit', 0, null)
          startChild.emit('close', 0, null)
        })
        return startChild
      })
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const priorExitCode = process.exitCode

      await main([
        'vm',
        'recipe',
        'doctor',
        'cloud-sandbox',
        '--repo-path',
        repoPath,
        '--provision',
        '--json'
      ])

      const output = JSON.parse(String(logSpy.mock.calls[0][0])) as {
        ok: boolean
        checks: { id: string; status: string }[]
        provisionTranscript?: {
          provision: {
            exitCode: number | null
            stdout: string
            stderr: string
            parseError?: string
          }
        }
      }
      expect(output.ok).toBe(false)
      expect(output.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'recipe.provision', status: 'fail' })
        ])
      )
      // The agent gets the full create output, not a 500-char tail.
      expect(output.provisionTranscript?.provision.stdout).toContain('Provisioning sandbox...')
      expect(output.provisionTranscript?.provision.stderr).toContain('missing scope')
      expect(output.provisionTranscript?.provision.parseError).toBeTruthy()
      process.exitCode = priorExitCode
    } finally {
      rmSync(repoPath, { recursive: true, force: true })
    }
  })
})
