import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { partialRuntimeStore, storeRepo, storeWorktreeMeta } from './runtime-store-partial-fixture'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import { registerBoundPty } from './bind-first-pane.test-fixture'
import type { HostShellLifecycleObservation } from '../../shared/terminal-shell-lifecycle'
import { terminalShellLifecycleObservation } from './terminal-shell-lifecycle-observation'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: () => null },
  webContents: { fromId: () => null },
  ipcMain: { on() {}, removeListener() {} },
  app: { getPath: () => '/tmp' }
}))

const prompt: HostShellLifecycleObservation = {
  confidence: 'cooperative',
  phase: 'prompt',
  source: 'managed-bash',
  reason: 'managed-bash-prompt',
  generation: 7,
  signalAgeMs: 10,
  ptyIncarnationId: 'inc-1',
  authorityGeneration: 'host-epoch'
}

async function createPane(options: {
  processInspection: PtyProcessInspection
  onProcessInspection?: () => void
  inspect?: () => Promise<PtyProcessInspection>
}) {
  const repo = storeRepo({
    id: 'repo-1',
    path: '/repo/app',
    kind: 'folder',
    executionHostId: 'local'
  })
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({
        'repo-1::/repo/app': storeWorktreeMeta({ instanceId: 'folder-instance' })
      })
    })
  )
  runtime.setPtyController({
    write: () => {
      throw new Error('observation must not write')
    },
    kill: () => {
      throw new Error('observation must not kill')
    },
    getForegroundProcess: async () => 'bash',
    inspectProcess: async () => {
      options.onProcessInspection?.()
      return options.inspect ? options.inspect() : options.processInspection
    }
  })
  const handle = runtime.preAllocateHandleForPty('pty-1')
  registerBoundPty(runtime, 'pty-1', 'repo-1::/repo/app', null, {
    tabId: 'tab-1',
    leafId: '11111111-1111-4111-8111-111111111111',
    incarnationId: 'inc-1'
  })
  return { runtime, handle }
}

describe('terminal show shell lifecycle', () => {
  it('includes transport time in freshness and publishes only the public metadata', () => {
    const result = terminalShellLifecycleObservation(
      {
        handle: 'term-1',
        ptyId: 'pty-1',
        incarnationId: 'inc-1',
        connected: true,
        executionHostId: 'local',
        writable: true,
        worktreeId: 'workspace',
        worktreePath: '',
        branch: '',
        tabId: 'tab',
        leafId: 'leaf',
        title: null,
        lastOutputAt: null,
        preview: ''
      },
      'runtime',
      {
        foregroundProcess: 'bash',
        hasChildProcesses: false,
        childProcessEvidence: 'no-children',
        shellLifecycle: { ...prompt, signalAgeMs: 29_500 }
      },
      'old-host',
      600
    )
    expect(result).toMatchObject({ phase: 'unknown', reason: 'stale', signalAgeMs: 30_100 })
    expect(result).not.toHaveProperty('ptyIncarnationId')
  })

  it('cannot publish the old incarnation when replacement races process inspection', async () => {
    let release: (value: PtyProcessInspection) => void = () => {
      throw new Error('inspection not started')
    }
    let started = false
    const { runtime, handle } = await createPane({
      processInspection: { foregroundProcess: null, hasChildProcesses: false },
      inspect: () => {
        started = true
        return new Promise((resolve) => {
          release = resolve
        })
      }
    })
    const reading = runtime.showTerminal(handle, { includeShellLifecycle: true })
    await vi.waitFor(() => expect(started).toBe(true))
    registerBoundPty(runtime, 'pty-1', 'repo-1::/repo/app', null, {
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      incarnationId: 'inc-2'
    })
    release({
      foregroundProcess: 'bash',
      hasChildProcesses: false,
      childProcessEvidence: 'no-children',
      shellLifecycle: prompt
    })
    expect((await reading).shellLifecycle).toMatchObject({
      phase: 'unknown',
      reason: 'incarnation-changed'
    })
  })
  it('opts into host-bound evidence without input, and leaves ordinary show unchanged', async () => {
    let inspections = 0
    const { runtime, handle } = await createPane({
      processInspection: {
        foregroundProcess: 'bash',
        hasChildProcesses: false,
        childProcessEvidence: 'no-children',
        shellLifecycle: prompt
      },
      onProcessInspection: () => {
        inspections++
      }
    })
    expect((await runtime.showTerminal(handle)).shellLifecycle).toBeUndefined()
    const shown = await runtime.showTerminal(handle, { includeShellLifecycle: true })
    expect(shown.shellLifecycle).toMatchObject({
      phase: 'prompt',
      incarnationId: 'inc-1',
      ptyId: 'pty-1',
      authorityGeneration: 'host-epoch',
      generation: 7,
      runtimeId: runtime.getRuntimeId(),
      executionHostId: 'local'
    })
    expect(inspections).toBe(1)
  })

  it.each([
    { label: 'old-host', signal: undefined, children: 'no-children' as const },
    {
      label: 'incarnation-mismatch',
      signal: { ...prompt, ptyIncarnationId: 'retired' },
      children: 'no-children' as const
    },
    {
      label: 'stale',
      signal: { ...prompt, signalAgeMs: 30_001 },
      children: 'no-children' as const
    },
    { label: 'children', signal: prompt, children: 'children' as const },
    { label: 'unverifiable', signal: prompt, children: 'unverifiable' as const }
  ])('keeps $label evidence unknown', async ({ signal, children }) => {
    const { runtime, handle } = await createPane({
      processInspection: {
        foregroundProcess: 'bash',
        hasChildProcesses: children !== 'no-children',
        childProcessEvidence: children,
        ...(signal ? { shellLifecycle: signal } : {})
      }
    })
    expect(
      (await runtime.showTerminal(handle, { includeShellLifecycle: true })).shellLifecycle
    ).toMatchObject({ phase: 'unknown' })
  })
})
