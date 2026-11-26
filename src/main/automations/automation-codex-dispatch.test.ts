import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { AutomationService } from './automation-service'
import type { AutomationCreateInput } from '../../shared/automations/automation-definition'
import type { Repo } from '../../shared/repository/repo-types'
import type { AutomationLauncher } from './launch/automation-launch'
import { prepareAutomationCodexLaunch } from './launch/automation-codex-launch'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const repo: Repo = {
  id: 'test-project',
  path: '/sample',
  displayName: 'Sample',
  badgeColor: '',
  addedAt: 1
}

const definition: AutomationCreateInput = {
  name: 'Sample check',
  prompt: 'Check the sample.',
  agentId: 'codex',
  projectId: repo.id,
  workspaceMode: 'new_per_run',
  timezone: 'UTC',
  rrule: '0 9 * * *',
  dtstart: 1
}

beforeEach(async () => {
  testState.dir = await mkdtemp(join(tmpdir(), 'orca-automation-dispatch-'))
})

afterEach(async () => {
  await closeTestStores()
  await rm(testState.dir, { recursive: true, force: true })
})

it('hands off each claimed run once, with the original prompt, after preparation', async () => {
  const store = await createStore()
  store.addRepo(repo)
  const terminal = store.createAutomation({
    ...definition,
    updateCodexBeforeRun: true
  })
  const chat = store.createAutomation({
    ...definition,
    prompt: 'Check it from Chat.',
    updateCodexBeforeRun: true,
    launchSetupPatch: { surface: 'chat' }
  })
  const legacy = store.createAutomation(definition)
  const prepared = Promise.withResolvers<string>()
  const preparing = Promise.withResolvers<void>()
  let waiting = 0
  const delivered: Record<string, { prompt: string; program: string | undefined }[]> = {}
  const launch: AutomationLauncher = async ({ automation, run, verifiedCodexProgram }) => {
    const invocations = (delivered[run.id] ??= [])
    invocations.push({
      prompt: automation.prompt,
      program: verifiedCodexProgram
    })
    return { workspaceId: 'workspace', terminalSessionId: 'terminal' }
  }
  const service = new AutomationService(store, {
    terminalLauncher: { launch, available: () => true },
    chatDispatcher: launch,
    prepareCodexRun: () => {
      if (++waiting === 2) {
        preparing.resolve()
      }
      return prepared.promise
    }
  })
  try {
    const [a, b, c] = await Promise.all([
      service.runNow(terminal.id),
      service.runNow(chat.id),
      service.runNow(legacy.id)
    ])
    await preparing.promise
    await vi.waitFor(() => {
      expect(store.listAutomationRuns(legacy.id)[0]?.status).toBe('dispatched')
    })
    expect(delivered).toEqual({ [c.id]: [{ prompt: 'Check the sample.', program: undefined }] })

    prepared.resolve('/sample/bin/codex')
    await vi.waitFor(() => {
      expect(store.listAutomationRuns(terminal.id)[0]?.status).toBe('dispatched')
      expect(store.listAutomationRuns(chat.id)[0]?.status).toBe('dispatched')
    })
    expect(delivered).toEqual({
      [a.id]: [{ prompt: 'Check the sample.', program: '/sample/bin/codex' }],
      [b.id]: [{ prompt: 'Check it from Chat.', program: '/sample/bin/codex' }],
      [c.id]: [{ prompt: 'Check the sample.', program: undefined }]
    })
  } finally {
    service.stop()
  }
})

it('refuses SSH and paired targets before checking the current process host', async () => {
  const store = await createStore()
  const scope = {
    executionTargetType: 'local' as const,
    workspaceMode: 'existing' as const,
    workspaceId: 'other::workspace'
  }
  const runtime = {
    resolveManagedTerminalWorkspaceTarget: async () => {
      throw new Error('A foreign workspace must never fall through to local resolution.')
    }
  }
  const signal = new AbortController().signal
  for (const targetRepo of [
    { ...repo, executionHostId: 'ssh:other' as const },
    { ...repo, executionHostId: 'runtime:remote' as const }
  ]) {
    await expect(
      prepareAutomationCodexLaunch(
        runtime,
        store,
        scope,
        { ok: true, cwd: targetRepo.path, repo: targetRepo },
        signal
      )
    ).rejects.toThrow('Checking for Codex updates is unavailable on this execution host.')
  }
})

it('records an update refusal without launching the run', async () => {
  const store = await createStore()
  store.addRepo(repo)
  const automation = store.createAutomation({ ...definition, updateCodexBeforeRun: true })
  const service = new AutomationService(store, {
    terminalLauncher: {
      available: () => true,
      launch: async () => {
        throw new Error('Unexpected prompt delivery')
      }
    },
    prepareCodexRun: async () => {
      throw new Error('This Codex installation requires a manual update before the run can start.')
    }
  })
  try {
    await service.runNow(automation.id)
    await vi.waitFor(() => {
      expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
        status: 'dispatch_failed',
        error: 'This Codex installation requires a manual update before the run can start.'
      })
    })
  } finally {
    service.stop()
  }
})
