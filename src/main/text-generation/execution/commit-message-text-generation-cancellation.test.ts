import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelGenerateCommitMessageLocal,
  generateCommitMessageFromContext
} from '../commit-message-text-generation'
import {
  createChildTerminationExpectation,
  createMockDiscoveryChild,
  spawnedAgentArgv
} from './commit-message-text-generation-test-harness'

const { terminateWindowsProcessTreeMock } = vi.hoisted(() => ({
  terminateWindowsProcessTreeMock: vi.fn(async () => {})
}))

vi.mock('../../pty/process-retirement/windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: terminateWindowsProcessTreeMock
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn)
  }
})

const spawnMock = vi.mocked(spawn)

const expectChildTerminated = createChildTerminationExpectation(terminateWindowsProcessTreeMock)

// Fake Windows direct-child/taskkill paths here; source-control-local-process.test.ts covers supervised POSIX stop and managed-home lock release.
const hostPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  vi.unstubAllEnvs()
})

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  // Clear PATH so host agent installations cannot answer the fake Windows binary lookup.
  vi.stubEnv('PATH', '')
  terminateWindowsProcessTreeMock.mockClear()
  terminateWindowsProcessTreeMock.mockResolvedValue(undefined)
  spawnMock.mockClear()
})

function generationSpawns() {
  return spawnMock.mock.calls.filter((call) => !spawnedAgentArgv(call).includes('mcp'))
}

function policyProbeChild() {
  const child = createMockDiscoveryChild()
  child.stdin.end.mockImplementation(() =>
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('[]'))
      child.emit('close', 0)
    })
  )
  return child
}

describe('generateCommitMessageFromContext on the Windows direct-child path', () => {
  it.each(['root-first', 'tree-first'] as const)(
    'cancels a live Codex policy probe and retains its home until both stop proofs (%s)',
    async (order) => {
      const stopped = Promise.withResolvers<void>()
      terminateWindowsProcessTreeMock.mockReturnValueOnce(stopped.promise)
      const probe = createMockDiscoveryChild()
      const later = createMockDiscoveryChild()
      const laterSpawned = Promise.withResolvers<void>()
      spawnMock.mockImplementationOnce(() => probe)
      spawnMock.mockImplementation((...args) => {
        if (spawnedAgentArgv(args).includes('mcp')) {
          return policyProbeChild()
        }
        laterSpawned.resolve()
        return later
      })
      const env = { CODEX_HOME: `C:\\managed\\probe-${order}` }
      const context = { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' }
      const params = { agentId: 'codex' as const, model: 'gpt-5.5' }
      const first = generateCommitMessageFromContext(context, params, {
        kind: 'local',
        cwd: `/probe-${order}`,
        env
      })
      await vi.waitFor(() => expect(probe.stdin.end).toHaveBeenCalled())
      cancelGenerateCommitMessageLocal(`/probe-${order}`)
      await expect(first).resolves.toMatchObject({ canceled: true })
      const second = generateCommitMessageFromContext(context, params, {
        kind: 'local',
        cwd: `/after-probe-${order}`,
        env
      })
      // Late valid output cannot start the canceled semantic operation.
      probe.stdout.emit('data', Buffer.from('[]'))
      if (order === 'root-first') {
        probe.emit('exit', null, 'SIGKILL')
      } else {
        stopped.resolve()
        await expectChildTerminated(probe)
      }
      await new Promise<void>((done) => setImmediate(done))
      expect(generationSpawns()).toHaveLength(0)
      if (order === 'root-first') {
        stopped.resolve()
      } else {
        probe.emit('exit', null, 'SIGKILL')
      }
      await laterSpawned.promise
      later.stdout.emit('data', Buffer.from('Update README\n'))
      later.emit('close', 0)
      await expect(second).resolves.toMatchObject({ success: true, message: 'Update README' })
      expect(generationSpawns()).toHaveLength(1)
    }
  )
})
