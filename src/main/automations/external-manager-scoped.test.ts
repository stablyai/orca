import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScopedExternalAutomations } from './external-manager'
import { ExternalAutomationManagerCache } from './external-automation-manager-cache'
import { ExternalAutomationProbeScheduler } from './external-automation-probe-scheduler'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'
import { AutomationOwnerConflictError } from '../../shared/automation-owner-conflict'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import type { SshTarget } from '../../shared/ssh-types'
import type * as Fs from 'node:fs'
import type * as Os from 'node:os'

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
  it('reports an SSH host this process does not serve without probing this computer', async () => {
    const engine = buildEngine([sshTarget(), sshTarget({ id: 'target-b', generation: 1 })])

    const entry = await engine.listManager({
      owner: desktopSsh('target-a', 3),
      provider: 'openclaw'
    })

    expect(entry).toMatchObject({ manager: null, error: SSH_HOST_NOT_SERVED_MESSAGE })
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
