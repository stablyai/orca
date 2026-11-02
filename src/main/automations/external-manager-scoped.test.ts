import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScopedExternalAutomations } from './external-manager'
import { ExternalAutomationManagerCache } from './external-automation-manager-cache'
import { ExternalAutomationProbeScheduler } from './external-automation-probe-scheduler'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'
import { AutomationOwnerConflictError } from '../../shared/automation-owner-conflict'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import {
  EXTERNAL_AUTOMATION_SCOPE_CODES,
  ExternalAutomationScopeError
} from '../../shared/external-automation-scope'
import type { ExternalAutomationProvider } from '../../shared/automations-types'
import type { SshTarget } from '../../shared/ssh-types'
import type * as Fs from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'

const runProcessMock = vi.hoisted(() => vi.fn())
const existsSyncMock = vi.hoisted(() => vi.fn<(file: Fs.PathLike) => boolean>(() => false))
const readFileMock = vi.hoisted(() => vi.fn())
const writeFileMock = vi.hoisted(() => vi.fn())
const fixtureHome = vi.hoisted(() => 'external-manager-fixture-home')

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof Fs>('fs')
  return { ...actual, existsSync: existsSyncMock }
})
vi.mock('node:fs/promises', () => ({ readFile: readFileMock, writeFile: writeFileMock }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: () => fixtureHome
}))

function sshTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'target-a',
    label: 'Build box',
    host: 'build.example',
    port: 22,
    username: 'orca',
    generation: 3,
    ...overrides
  }
}

const desktopSelf: AutomationOwnerRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
}

function desktopSsh(targetId: string, targetGeneration: number): AutomationOwnerRef {
  return { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId, targetGeneration } }
}

function buildEngine(targets: SshTarget[]) {
  return createScopedExternalAutomations({
    registry: { getSshTargets: () => targets },
    scheduler: new ExternalAutomationProbeScheduler(),
    cache: new ExternalAutomationManagerCache({ ttlMs: 0 })
  })
}

beforeEach(() => {
  runProcessMock.mockReset()
  runProcessMock.mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  })
  existsSyncMock.mockReturnValue(false)
  readFileMock.mockReset()
  writeFileMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('scoped external automations', () => {
  it('discovers only OpenClaw and leaves isolated Hermes cron files untouched', async () => {
    const files = new Map([
      [join(fixtureHome, '.hermes', 'cron', 'jobs.json'), '[{"id":"hermes-job","enabled":true}]'],
      [join(fixtureHome, '.hermes', 'state.db'), 'Hermes session fixture'],
      [join(fixtureHome, '.hermes', 'cron', 'executions.db'), 'Hermes execution fixture'],
      [join(fixtureHome, '.hermes', 'cron', 'output', 'hermes-job', 'run.md'), '# Output\nDone'],
      [join(fixtureHome, '.hermes', 'config.yaml'), 'model: fixture-model'],
      [
        join(fixtureHome, '.openclaw', 'cron', 'jobs.json'),
        '{"jobs":[{"id":"claw-job","name":"OpenClaw job","enabled":true}]}'
      ]
    ])
    const before = [...files]
    existsSyncMock.mockImplementation((file) => files.has(String(file)))
    readFileMock.mockImplementation(async (file) => {
      const content = files.get(String(file))
      if (content === undefined) {
        throw new Error('Unexpected fixture read')
      }
      return content
    })

    const entry = await buildEngine([]).listManager({ owner: desktopSelf, provider: 'openclaw' })

    expect(entry.manager?.jobs.map((job) => job.id)).toEqual(['claw-job'])
    expect(readFileMock).toHaveBeenCalledExactlyOnceWith(
      join(fixtureHome, '.openclaw', 'cron', 'jobs.json'),
      'utf-8'
    )
    expect(existsSyncMock).toHaveBeenCalledExactlyOnceWith(
      join(fixtureHome, '.openclaw', 'cron', 'jobs.json')
    )
    expect(runProcessMock).toHaveBeenCalledExactlyOnceWith({
      program: process.platform === 'win32' ? 'where' : 'which',
      args: ['openclaw'],
      timeoutMs: 5_000
    })
    expect(writeFileMock).not.toHaveBeenCalled()
    expect([...files]).toEqual(before)
  })

  it('reports an SSH host this process does not serve without probing this computer', async () => {
    const engine = buildEngine([sshTarget(), sshTarget({ id: 'target-b', generation: 1 })])

    const entry = await engine.listManager({
      owner: desktopSsh('target-a', 3),
      provider: 'openclaw'
    })

    expect(entry).toMatchObject({ manager: null, error: SSH_HOST_NOT_SERVED_MESSAGE })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('fails closed on a stale generation without probing', async () => {
    const engine = buildEngine([sshTarget({ generation: 4 })])

    await expect(
      engine.listManager({ owner: desktopSsh('target-a', 3), provider: 'openclaw' })
    ).rejects.toBeInstanceOf(AutomationOwnerConflictError)
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('excludes a runtime-owned target without probing it', async () => {
    const engine = buildEngine([
      sshTarget({ owner: { type: 'on-demand-runtime', runtimeId: 'rt-1' } })
    ])

    await expect(
      engine.listManager({ owner: desktopSsh('target-a', 3), provider: 'openclaw' })
    ).rejects.toBeInstanceOf(ExternalAutomationScopeError)
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('rejects a runtime authority before any probe', async () => {
    const engine = buildEngine([])

    await expect(
      engine.listManager({
        owner: {
          authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 2 },
          selector: { kind: 'self' }
        },
        provider: 'openclaw'
      })
    ).rejects.toThrow(EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported)
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown provider before launching any command', async () => {
    const engine = buildEngine([sshTarget()])
    const unknown = 'cron' as ExternalAutomationProvider

    await expect(
      engine.runAction({
        owner: desktopSelf,
        provider: unknown,
        jobId: 'job-1',
        action: 'delete'
      })
    ).rejects.toThrow(EXTERNAL_AUTOMATION_SCOPE_CODES.providerNotAllowed)
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('fails a scoped mutation closed when the host changed under the dialog', async () => {
    const engine = buildEngine([sshTarget({ generation: 5 })])

    await expect(
      engine.runAction({
        owner: desktopSsh('target-a', 3),
        provider: 'openclaw',
        jobId: 'job-1',
        action: 'run'
      })
    ).rejects.toBeInstanceOf(AutomationOwnerConflictError)
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
