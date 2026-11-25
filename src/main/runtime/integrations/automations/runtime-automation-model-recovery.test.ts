import { expect, it } from 'vitest'
import type {
  Automation,
  AutomationBotTarget
} from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import {
  automationModelRecoveryTarget,
  type AutomationModelRecoveryInput
} from '../../../../shared/automations/history/automation-model-recovery'
import { automationRunModelUnavailable } from '../../../../shared/automations/history/automation-run-model-failure'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  type AgentChatPermissionMode
} from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { normalizeAgentLaunchChoices } from '../../../../shared/agent-launch/choices/agent-launch-choices'
import {
  seededPermissionMode,
  structuredLaunchSeedOptions
} from '../../../../shared/native-chat/input/session-options/native-chat-session-option-defaults'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getDefaultPersistedState } from '../../../../shared/orca-profiles/constants'
import { FolderWorkspacePersistenceOperations } from '../../../persistence/restoring-sessions/folder-workspace-operations'
import { updateSettings } from '../../../persistence/applying-settings/settings-update'
import {
  createAutomationRun,
  listAutomationRuns
} from '../../../persistence/scheduling-automations/automation-run-operations'
import { updateAutomation } from '../../../persistence/scheduling-automations/automation-definition-update'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { botBackgroundStartOptions, botStartPermission } from '../../../bots/bot-start-options'
import {
  readAutomationRecoverySelection,
  recoverAutomationModel
} from './runtime-automation-model-recovery'

type RecoveryOptions = {
  run?: Partial<AutomationRun>
  target?: Partial<AutomationBotTarget>
  destinationBeforeHandler?: AutomationBotTarget['resultsTo']
  folderMoveBeforeHandler?: string
  settingsModel?: string | null
  settingsOptions?: Record<string, string>
  input?: Partial<AutomationModelRecoveryInput>
  refuseRerun?: boolean
  inheritPermission?: true
  permissionBeforeHandler?: AgentChatPermissionMode
}

function beginRecovery(options: RecoveryOptions = {}) {
  let automation: Automation = {
    id: 'automation',
    name: 'Sample automation',
    prompt: 'Summarize sample notes',
    precheck: null,
    agentId: 'codex',
    bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'none', ...options.target },
    projectId: '',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 30,
    createdAt: 1,
    updatedAt: 1
  }
  const failed: AutomationRun = {
    id: 'failed',
    automationId: automation.id,
    title: 'Sample automation',
    status: 'dispatch_failed',
    trigger: 'manual',
    workspaceId: null,
    sessionKind: 'chat',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: 'Model unavailable',
    errorCode: 'agentModelUnavailable',
    errorParams: { agent: 'codex', model: 'old-model' },
    scheduledFor: 1,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 1,
    ...options.run
  }
  const folder: FolderWorkspace = {
    id: 'w1',
    projectGroupId: 'sample-group',
    name: 'Sample folder',
    folderPath: '/fixture/sample',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const persisted = Promise.withResolvers<void>()
  const pending = new Set<string>()
  const bot = makeTestBot({
    ...(options.inheritPermission ? { permissionMode: undefined } : {}),
    ...(options.settingsModel !== undefined
      ? {}
      : { launch: { model: 'old-model', options: { effort: 'high' } } })
  })
  const state = {
    ...getDefaultPersistedState('/fixture'),
    folderWorkspaces: [folder],
    automationRuns: [failed]
  }
  state.settings = {
    ...state.settings,
    botsEnabled: true,
    ...(options.settingsModel !== undefined
      ? {
          agentLaunchChoices: normalizeAgentLaunchChoices({
            codex: {
              model: options.settingsModel ?? undefined,
              options: options.settingsOptions
            }
          })
        }
      : {})
  }
  const writePermission = (permission: AgentChatPermissionMode) =>
    updateSettings(
      {
        state,
        bumpLocalWorktreeScanGeneration() {},
        removeRetainedBlob: () => undefined,
        scheduleSave() {},
        notifySettingsChanged() {}
      },
      { agentPermissionDefault: permission }
    )
  writePermission('ask')
  const getSettings = () => state.settings
  const readSelection = () =>
    readAutomationRecoverySelection({ getSettings, getBots: () => [bot] }, automation.bot)
  const expectedTarget = automationModelRecoveryTarget(
    automation.bot!,
    bot,
    folder.folderPath,
    readSelection()?.permission ?? 'ask'
  )
  const folders = new FolderWorkspacePersistenceOperations({
    state,
    scheduleSave() {},
    removeWorkspaceLineageForRemovedFolder() {},
    pruneMobileClientTabSelections() {},
    hydrateRepo: (repo) => repo
  })
  if (options.permissionBeforeHandler) {
    writePermission(options.permissionBeforeHandler)
  }
  if (options.folderMoveBeforeHandler) {
    folders.updateFolderWorkspace(folder.id, { folderPath: options.folderMoveBeforeHandler })
  }
  if (options.destinationBeforeHandler) {
    automation = {
      ...automation,
      bot: { ...automation.bot!, resultsTo: options.destinationBeforeHandler }
    }
  }
  const recover = () =>
    recoverAutomationModel(
      pending,
      {
        assertOwner: () => {},
        show: () => automation,
        listRuns: (id) => listAutomationRuns(state, id)
      },
      {
        getSettings,
        getBots: () => [bot],
        getFolderWorkspaces: () => folders.getFolderWorkspaces(),
        updateAutomation: (_id, { bot, agentId }) =>
          (automation = { ...automation, bot, agentId: agentId ?? automation.agentId }),
        flushPendingOrThrowAsync: () => persisted.promise
      },
      {
        runNow: async () => {
          const run = createAutomationRun(
            { state, flush() {}, recordManualRun() {}, getWorkspaceDisplayName: () => null },
            automation,
            2,
            'manual',
            undefined,
            'queued'
          )
          if (options.refuseRerun) {
            throw new Error('Queue acknowledgement lost')
          }
          return run
        }
      },
      { id: 'automation', runId: 'failed', expectedTarget, model: 'replacement', ...options.input }
    )

  return {
    recovery: recover(),
    recover,
    readSelection,
    persistedSettingsModel: () => state.settings.agentLaunchChoices?.codex?.model,
    backgroundSettings: () => botBackgroundStartOptions(getSettings(), bot),
    queued: () =>
      listAutomationRuns(state, automation.id).filter((run) => run.status === 'pending'),
    createPermission: () =>
      botStartPermission(bot) ??
      seededPermissionMode(structuredLaunchSeedOptions(state.settings, bot.agent))?.[
        AGENT_CHAT_PERMISSION_MODE_OPTION_ID
      ],
    writePermission,
    moveFolder: (path: string) => {
      folders.updateFolderWorkspace(folder.id, { folderPath: path })
      persisted.resolve()
    },
    acceptSave: persisted.resolve,
    rejectSave: persisted.reject,
    get target() {
      return automation.bot
    },
    editWithOwnerWriter: (target: AutomationBotTarget) => {
      state.automations = [automation]
      automation = updateAutomation(
        { state, storageAuthority: 'desktop', flush() {}, recordCreated() {} },
        automation.id,
        { bot: target },
        { expectedOwner: { selector: { kind: 'self' } } }
      )
    },
    editTarget: (bot: AutomationBotTarget) => {
      automation = { ...automation, bot }
      persisted.resolve()
    }
  }
}

it('refuses a same-ID folder move made before the handler and preserves a move made during the save', async () => {
  const before = beginRecovery({ folderMoveBeforeHandler: '/fixture/moved' })
  before.acceptSave()
  await expect(before.recovery).resolves.toEqual({ status: 'changed' })
  expect(before.target?.agentSetup).toBeUndefined()

  const during = beginRecovery()
  during.moveFolder('/fixture/moved')
  await expect(during.recovery).resolves.toEqual({ status: 'saved', rerun: 'skipped' })
  expect(during.target?.agentSetup?.launch?.model).toBe('replacement')
})

it('shows the owner Settings model, refuses the same choice and queues a different one', async () => {
  const same = beginRecovery({
    settingsModel: 'settings-model',
    input: { model: 'settings-model' }
  })
  expect(same.readSelection()).toMatchObject({ model: 'settings-model', permission: 'ask' })
  same.acceptSave()
  await expect(same.recovery).resolves.toEqual({ status: 'changed' })
  expect(same.target?.agentSetup).toBeUndefined()

  const different = beginRecovery({ settingsModel: 'settings-model' })
  different.acceptSave()
  await expect(different.recovery).resolves.toEqual({ status: 'queued', runId: 'queued' })
  expect(different.readSelection()).toMatchObject({ model: 'replacement', permission: 'ask' })
})

it('rejects a blank recovery choice even with an inherited model', async () => {
  const pending = beginRecovery({ settingsModel: 'settings-model', input: { model: '  \t' } })
  expect(pending.readSelection()?.model).toBe('settings-model')
  pending.acceptSave()

  await expect(pending.recovery).resolves.toEqual({ status: 'changed' })
  expect(pending.target?.agentSetup).toBeUndefined()
  expect(pending.queued()).toHaveLength(0)
})

it('withholds a corrupt persisted Settings model from recovery reads and direct recovery', async () => {
  const settingsModel = 'sample\u0000corrupt'
  const pending = beginRecovery({ settingsModel })
  expect(pending.persistedSettingsModel()).toBe(settingsModel)
  expect(pending.backgroundSettings().model).toBe(settingsModel)
  expect(pending.readSelection()).toBeUndefined()
  pending.acceptSave()
  await expect(pending.recovery).resolves.toEqual({ status: 'changed' })
  expect(pending.target?.agentSetup).toBeUndefined()
  expect(pending.queued()).toHaveLength(0)
})

it('fences changed inherited permission before and after save, but honors a supported bot override', async () => {
  const before = beginRecovery({ inheritPermission: true, permissionBeforeHandler: 'full-access' })
  before.acceptSave()
  await expect(before.recovery).resolves.toEqual({ status: 'changed' })
  expect(before.target?.agentSetup).toBeUndefined()
  expect(before.queued()).toHaveLength(0)

  const during = beginRecovery({ inheritPermission: true })
  expect(during.readSelection()?.permission).toBe('ask')
  expect(during.createPermission()).toBe('ask')
  during.writePermission('full-access')
  expect(during.readSelection()?.permission).toBe('full-access')
  expect(during.createPermission()).toBe('full-access')
  during.acceptSave()
  await expect(during.recovery).resolves.toEqual({ status: 'saved', rerun: 'skipped' })
  expect(during.target?.agentSetup?.launch?.model).toBe('replacement')
  expect(during.queued()).toHaveLength(0)

  const explicit = beginRecovery()
  explicit.writePermission('full-access')
  expect(explicit.readSelection()?.permission).toBe('ask')
  expect(explicit.createPermission()).toBe('ask')
  explicit.acceptSave()
  await expect(explicit.recovery).resolves.toEqual({ status: 'queued', runId: 'queued' })
  expect(explicit.queued().map((run) => run.id)).toEqual(['queued'])
})

it('preserves an intervening destination edit and skips delivery after saving the model', async () => {
  const pending = beginRecovery()
  pending.editTarget({ ...pending.target!, resultsTo: 'chat' })

  await expect(pending.recovery).resolves.toEqual({ status: 'saved', rerun: 'skipped' })
  expect(pending.target).toEqual({
    botId: 'bot-1',
    runsIn: 'new',
    resultsTo: 'chat',
    agentSetup: { agent: 'codex', launch: { model: 'replacement', options: { effort: 'high' } } }
  })
})

it('rejects a destination edit before the recovery handler reads the automation', async () => {
  const pending = beginRecovery({ destinationBeforeHandler: { channel: 'sample-channel' } })
  pending.acceptSave()

  await expect(pending.recovery).resolves.toEqual({ status: 'changed' })
  expect(pending.target).toEqual({
    botId: 'bot-1',
    runsIn: 'new',
    resultsTo: { channel: 'sample-channel' }
  })
})

const invalidRecoveries: (RecoveryOptions & { description: string })[] = [
  { description: 'an unclassified run', run: { errorCode: undefined } },
  { description: 'a completed run', run: { status: 'completed' } },
  { description: 'a chat destination', target: { runsIn: 'chat' } },
  {
    description: 'the current saved model after a different model failed',
    run: { errorParams: { agent: 'codex', model: 'previous-model' } },
    input: { model: 'old-model' }
  },
  {
    description: 'a different agent',
    run: { errorParams: { agent: 'claude', model: 'old-model' } }
  },
  { description: 'the failed model', input: { model: 'old-model' } },
  {
    description: 'a failed model with a bounded history ID',
    run: { errorParams: { agent: 'codex', model: 'x'.repeat(120) } },
    input: { model: 'x'.repeat(130) }
  }
]

it.each(invalidRecoveries)(
  'leaves the automation unchanged when recovering $description',
  async (options) => {
    const pending = beginRecovery(options)
    pending.acceptSave()

    await expect(pending.recovery).resolves.toEqual({ status: 'changed' })
    expect(pending.target?.agentSetup).toBeUndefined()
  }
)

it('prevents another recovery during an unacknowledged write', async () => {
  const pending = beginRecovery()
  await expect(pending.recover()).resolves.toEqual({ status: 'busy' })

  pending.rejectSave(new Error('Write acknowledgement lost'))
  await expect(pending.recovery).resolves.toEqual({ status: 'unconfirmed' })
})

it('distinguishes model IDs that have the same bounded history text', async () => {
  const failedModel = `${'x'.repeat(120)}-failed`
  const alternative = `${'x'.repeat(120)}-alternative`
  const run = automationRunModelUnavailable({
    agent: 'codex',
    model: failedModel,
    launchModel: failedModel
  })
  const same = beginRecovery({ run, input: { model: failedModel } })
  const different = beginRecovery({ run, input: { model: alternative } })
  same.acceptSave()
  different.acceptSave()

  await expect(same.recovery).resolves.toEqual({ status: 'changed' })
  await expect(different.recovery).resolves.toEqual({ status: 'queued', runId: 'queued' })
  expect(different.target?.agentSetup?.launch?.model).toBe(alternative)
})

it('reports an uncertain queue acknowledgement and retains the saved model', async () => {
  const pending = beginRecovery({ refuseRerun: true })
  pending.acceptSave()

  await expect(pending.recovery).resolves.toEqual({ status: 'saved', rerun: 'unconfirmed' })
  expect(pending.target?.agentSetup?.launch?.model).toBe('replacement')
})

it('admits a rerun with a newer model saved for the same destination', async () => {
  const pending = beginRecovery()
  pending.editTarget({
    ...pending.target!,
    agentSetup: { agent: 'codex', launch: { model: 'newer-model', options: { effort: 'high' } } }
  })

  await expect(pending.recovery).resolves.toEqual({
    status: 'queued',
    runId: 'queued',
    newerModel: true
  })
  expect(pending.target?.agentSetup?.launch?.model).toBe('newer-model')
})

it('skips automatic rerun when a concurrent save restores the failed model', async () => {
  const pending = beginRecovery()
  pending.editTarget({
    ...pending.target!,
    agentSetup: { agent: 'codex', launch: { model: 'old-model', options: { effort: 'high' } } }
  })

  await expect(pending.recovery).resolves.toEqual({ status: 'saved', rerun: 'skipped' })
  expect(pending.target?.agentSetup?.launch?.model).toBe('old-model')
  expect(pending.queued()).toHaveLength(0)
})

it('admits a newer inherited model when its effective non-model settings are equal', async () => {
  const inheritedTarget = { botId: 'bot-1', runsIn: 'new', resultsTo: 'none' } as const
  const pending = beginRecovery({
    settingsModel: 'model-c',
    settingsOptions: { effort: 'high' },
    target: {
      agentSetup: { agent: 'codex', launch: { model: 'old-model', options: { effort: 'high' } } }
    }
  })
  expect(pending.target?.agentSetup?.launch).toEqual({
    model: 'replacement',
    options: { effort: 'high' }
  })
  expect(pending.readSelection()?.permission).toBe('ask')
  pending.editWithOwnerWriter(inheritedTarget)
  expect(pending.target).toEqual(inheritedTarget)
  expect(pending.backgroundSettings()).toEqual({ model: 'model-c', effort: 'high' })
  expect(pending.readSelection()?.permission).toBe('ask')
  pending.acceptSave()

  await expect(pending.recovery).resolves.toEqual({
    status: 'queued',
    runId: 'queued',
    newerModel: true
  })
  expect(pending.target).toEqual(inheritedTarget)
  expect(pending.queued().map((run) => run.id)).toEqual(['queued'])
})

it('preserves an inheritance reset without an effective model and skips automatic queueing', async () => {
  const target = { botId: 'bot-1', runsIn: 'new', resultsTo: 'none' } as const
  const pending = beginRecovery({ settingsModel: null })
  expect(pending.target?.agentSetup?.launch).toEqual({ model: 'replacement' })
  pending.editWithOwnerWriter(target)
  expect(pending.readSelection()).toMatchObject({ model: null, permission: 'ask' })
  expect(pending.backgroundSettings()).toEqual({})
  pending.acceptSave()

  await expect(pending.recovery).resolves.toEqual({ status: 'saved', rerun: 'skipped' })
  expect(pending.target).toEqual(target)
  expect(pending.queued()).toHaveLength(0)

  const initialDefault = beginRecovery({ settingsModel: null })
  initialDefault.acceptSave()
  await expect(initialDefault.recovery).resolves.toEqual({ status: 'queued', runId: 'queued' })
  expect(initialDefault.readSelection()?.model).toBe('replacement')
})

it('retains a superseding model through a skipped queue or a lost queue acknowledgement', async () => {
  const target = { botId: 'bot-1', runsIn: 'new', resultsTo: 'none' } as const
  const skipped = beginRecovery({ settingsModel: 'model-c', settingsOptions: { effort: 'high' } })
  skipped.editWithOwnerWriter(target)
  skipped.acceptSave()
  await expect(skipped.recovery).resolves.toEqual({ status: 'saved', rerun: 'skipped' })
  expect(skipped.readSelection()?.model).toBe('model-c')
  expect(skipped.queued()).toHaveLength(0)

  const uncertain = beginRecovery({ settingsModel: 'model-c', refuseRerun: true })
  uncertain.editWithOwnerWriter(target)
  uncertain.acceptSave()
  await expect(uncertain.recovery).resolves.toEqual({ status: 'saved', rerun: 'unconfirmed' })
  expect(uncertain.readSelection()?.model).toBe('model-c')
  expect(uncertain.queued().map((run) => run.id)).toEqual(['queued'])
})

it('skips automatic rerun when a newer owner save changes effective non-model settings', async () => {
  const inheritedTarget = { botId: 'bot-1', runsIn: 'new', resultsTo: 'none' } as const
  const changed = beginRecovery({ settingsModel: 'model-c', settingsOptions: { effort: 'high' } })
  expect(changed.target?.agentSetup?.launch).toEqual({ model: 'replacement' })
  changed.editWithOwnerWriter(inheritedTarget)
  expect(changed.target).toEqual(inheritedTarget)
  expect(changed.backgroundSettings()).toEqual({ model: 'model-c', effort: 'high' })
  changed.acceptSave()
  await expect(changed.recovery).resolves.toEqual({ status: 'saved', rerun: 'skipped' })
  expect(changed.target).toEqual(inheritedTarget)
  expect(changed.queued()).toHaveLength(0)

  const explicit = beginRecovery({ settingsModel: 'model-c', settingsOptions: { effort: 'high' } })
  explicit.editWithOwnerWriter({
    ...inheritedTarget,
    agentSetup: { agent: 'codex', launch: { model: 'model-c' } }
  })
  explicit.acceptSave()
  await expect(explicit.recovery).resolves.toEqual({
    status: 'queued',
    runId: 'queued',
    newerModel: true
  })
  expect(explicit.queued().map((run) => run.id)).toEqual(['queued'])

  const inherited = beginRecovery({ settingsModel: 'model-c' })
  inherited.editWithOwnerWriter(inheritedTarget)
  expect(inherited.backgroundSettings()).toEqual({ model: 'model-c' })
  inherited.acceptSave()
  await expect(inherited.recovery).resolves.toEqual({
    status: 'queued',
    runId: 'queued',
    newerModel: true
  })
  expect(inherited.target).toEqual(inheritedTarget)
  expect(inherited.queued().map((run) => run.id)).toEqual(['queued'])
})
