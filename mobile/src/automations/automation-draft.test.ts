import { automationOrphanIssueText } from './automation-orphan-issue-copy'
import { AUTOMATION_ORPHAN_ISSUES } from '../../../src/shared/automation-list-scope'
import {
  loadAutomationTargets,
  automationSetupKey,
  workspaceMatchesSetup
} from './automation-target-inventory'
import { afterEach, describe, expect, it } from 'vitest'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import { automationRunErrorText } from './automation-run-presentation'
import { automationErrorMessage } from './automation-error'
import { AUTOMATION_RUN_FAILURE_COPY } from '../../../src/shared/automation-run-failure-copy'
import {
  AutomationCreate,
  AutomationUpdate
} from '../../../src/shared/rpc-contract/automation-params'
import { automationListSchema, runSchema } from './automation-reply-schema'
import {
  automationCreateParams,
  automationDraftPatch,
  automationUpdateParams,
  newAutomationDraft,
  validateAutomationDraft
} from './automation-draft'
import {
  automationClient,
  automationTargets,
  savedAutomation,
  savedRun
} from './automation-test-fixtures'

describe('mobile automation host contracts', () => {
  it('rejects changed blank grace, accepts explicit zero and preserves an untouched saved value', () => {
    const saved = savedAutomation()
    const original = newAutomationDraft(saved)
    for (const grace of ['', '  ']) {
      expect(validateAutomationDraft({ ...original, grace }, 2, saved)).toBe(
        'Missed-run grace must be zero or a positive number of minutes.'
      )
    }
    expect(validateAutomationDraft({ ...original, grace: '0' }, 2, saved)).toBeNull()
    expect(automationDraftPatch({ ...original, grace: '0' }, original)).toEqual({})
    const untouched = { ...saved, missedRunGraceMinutes: 720 }
    const draft = newAutomationDraft(untouched)
    expect(validateAutomationDraft(draft, 2, untouched)).toBeNull()
    expect(validateAutomationDraft({ ...draft, grace: '0' }, 2, untouched)).toBeNull()
    expect(
      automationUpdateParams(untouched.id, { ...draft, grace: '0' }, draft, automationTargets())
        .updates
    ).toEqual({ missedRunGraceMinutes: 0 })
    expect(
      automationUpdateParams(saved.id, { ...draft, name: 'Rename' }, draft, automationTargets())
        .updates
    ).toEqual({ name: 'Rename' })
  })

  it('shows localized local-validation remedies without exposing arbitrary host errors', async () => {
    const targets = automationTargets()
    const draft = {
      ...newAutomationDraft(savedAutomation()),
      setupId: automationSetupKey(targets.setups[0]!),
      workspaceMode: 'existing' as const,
      workspaceId: 'removed',
      extraAgentArgs: ''
    }
    await activateMobileUiLocale('fr')
    try {
      const failureMessage = (submit: () => unknown): string => {
        try {
          submit()
        } catch (error) {
          return automationErrorMessage(error)
        }
        throw new Error('Expected a local validation refusal')
      }
      expect(failureMessage(() => automationCreateParams(draft, targets))).toBe(
        'Choisissez un espace de travail existant.'
      )
      const remoteSetup = { ...targets.setups[0]!, hostId: 'ssh:removed' as const }
      expect(
        failureMessage(() =>
          automationCreateParams(
            { ...draft, setupId: automationSetupKey(remoteSetup), workspaceId: 'workspace-1' },
            {
              ...targets,
              setups: [remoteSetup],
              workspaces: [{ ...targets.workspaces[0]!, hostId: 'ssh:removed' }]
            }
          )
        )
      ).toBe('Cet hôte n’est plus disponible sur cette instance. Choisissez un hôte et réessayez.')
      expect(automationErrorMessage(new Error('Secret remote diagnostics'))).not.toContain('Secret')
    } finally {
      await activateMobileUiLocale('en')
    }
  })
  it('keeps target host identity and expands the managed inventory past the initial range', async () => {
    const base = automationTargets().setups[0]!
    const setups = [base, { ...base, hostId: 'ssh:builder' as const }]
    const worktrees = Array.from({ length: 202 }, (_, i) => ({
      id: `repo-1::/repo/${i}`,
      repoId: 'repo-1',
      path: `/repo/${i}`,
      displayName: `Workspace ${i}`,
      hostId: 'ssh:builder'
    }))
    const port = automationClient((method, params) => {
      if (method === 'project.list') {
        return { projects: [{ id: base.projectId, displayName: 'Project' }] }
      }
      if (method === 'projectHostSetup.list') {
        return { setups }
      }
      if (method === 'repo.list') {
        return {
          repos: [
            { id: base.repoId, displayName: 'Local', path: base.path },
            { id: base.repoId, displayName: 'SSH', path: base.path, connectionId: 'builder' }
          ]
        }
      }
      if (method === 'ssh.listTargetSummaries') {
        return { targets: [{ id: 'builder', label: 'Builder', generation: 7 }] }
      }
      if (method === 'worktree.list') {
        const limit =
          params &&
          typeof params === 'object' &&
          'limit' in params &&
          typeof params.limit === 'number'
            ? params.limit
            : 200
        return {
          worktrees: worktrees.slice(0, limit),
          totalCount: worktrees.length,
          truncated: limit < worktrees.length,
          hostScope: { hostIds: ['ssh:builder'], omittedHostIds: ['local'] }
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const initial = await loadAutomationTargets(port.client)
    expect(initial.setups).toHaveLength(2)
    expect(initial.coverage).toMatchObject({
      totalCount: 202,
      truncated: true,
      hostScope: { omittedHostIds: ['local'] }
    })
    const complete = await loadAutomationTargets(port.client, initial.coverage.totalCount)
    expect(complete.workspaces).toHaveLength(202)
    const selected = complete.setups.find((setup) => setup.hostId === 'ssh:builder')!
    const draft = {
      ...newAutomationDraft(),
      name: 'SSH',
      prompt: 'Review',
      agentId: 'codex' as const,
      setupId: automationSetupKey(selected),
      workspaceMode: 'existing' as const,
      workspaceId: complete.workspaces[201]!.worktreeId
    }
    expect(automationCreateParams(draft, complete)).toMatchObject({
      runContext: { hostId: 'ssh:builder', path: '/repo' },
      workspace: 'id:repo-1::/repo/201',
      destination: { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } }
    })
  })

  it('resolves legacy inventory only from a unique repo host and never assumes local', async () => {
    const setup = automationTargets().setups[0]!
    let repos: {
      id: string
      path: string
      displayName: string
      connectionId: string | null
    }[] = [{ id: setup.repoId, path: setup.path, displayName: 'Local', connectionId: null }]
    const port = automationClient((method) => {
      if (method === 'project.list') {
        return { projects: [] }
      }
      if (method === 'projectHostSetup.list') {
        return { setups: [setup] }
      }
      if (method === 'repo.list') {
        return { repos }
      }
      if (method === 'ssh.listTargetSummaries') {
        return { targets: [] }
      }
      if (method === 'worktree.list') {
        return {
          worktrees: [
            { id: 'legacy', repoId: setup.repoId, path: setup.path, displayName: 'Legacy' }
          ],
          totalCount: 1,
          truncated: false,
          hostScope: { hostIds: ['local'], omittedHostIds: [] }
        }
      }
      throw new Error(method)
    })
    const local = await loadAutomationTargets(port.client)
    expect(local.workspaces[0]?.hostId).toBe('local')
    expect(workspaceMatchesSetup(local.workspaces[0]!, setup)).toBe(true)
    repos = [{ ...repos[0]!, connectionId: 'builder' }]
    const remote = await loadAutomationTargets(port.client)
    expect(remote.workspaces[0]?.hostId).toBe('ssh:builder')
    expect(workspaceMatchesSetup(remote.workspaces[0]!, setup)).toBe(false)
    repos.push({ ...repos[0]!, connectionId: null })
    expect((await loadAutomationTargets(port.client)).workspaces).toEqual([])
    repos = []
    expect((await loadAutomationTargets(port.client)).workspaces).toEqual([])
  })

  it('edits a Chat automation without Terminal argument rules or a surface patch', () => {
    const saved = automationListSchema.parse({
      automations: [
        { ...savedAutomation(), surface: 'chat', extraAgentArgs: '--model old', reuseSession: true }
      ],
      items: [{ automationId: 'automation-1', selector: { kind: 'self' } }]
    })[0]!.automation
    const original = newAutomationDraft(saved)
    const revised = { ...original, name: 'Renamed', extraAgentArgs: '--model revised' }
    expect(validateAutomationDraft(revised, 2, saved)).toBeNull()
    expect(automationUpdateParams(saved.id, revised, original, automationTargets())).toEqual({
      id: saved.id,
      updates: { name: 'Renamed', extraAgentArgs: '--model revised' }
    })
    const retargeted = automationUpdateParams(
      saved.id,
      {
        ...revised,
        targetEdited: true,
        setupId: automationSetupKey(automationTargets().setups[0]!)
      },
      original,
      automationTargets()
    )
    expect(retargeted.updates).toMatchObject({ extraAgentArgs: '--model revised' })
    expect(retargeted.updates).not.toHaveProperty('launchSetupPatch')
    expect(retargeted.updates).not.toHaveProperty('surface')
  })

  it('creates enabled using real host selectors and a captured setup', () => {
    const draft = {
      ...newAutomationDraft(),
      name: 'Daily review',
      prompt: 'Review changes',
      agentId: 'codex' as const,
      setupId: automationSetupKey(automationTargets().setups[0]!),
      workspaceMode: 'existing' as const,
      workspaceId: 'workspace-1'
    }
    const params = AutomationCreate.parse(
      automationCreateParams(draft, automationTargets(), 'creation-1')
    )
    expect(params).toMatchObject({
      enabled: true,
      repo: 'id:repo-1',
      workspace: 'id:workspace-1',
      creationKey: 'creation-1',
      destination: { selector: { kind: 'self' } },
      runContext: {
        projectId: 'project-1',
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      }
    })
    expect(params.baseBranch).toBeUndefined()
  })
  it('edits only changed fields, preserving paused/custom/advanced and future host values', () => {
    const saved = savedAutomation()
    const original = newAutomationDraft(saved)
    const params = automationUpdateParams(
      saved.id,
      { ...original, name: 'Renamed' },
      original,
      automationTargets()
    )
    expect(AutomationUpdate.parse(params)).toMatchObject({
      id: saved.id,
      updates: { name: 'Renamed' }
    })
    expect(params.updates).toEqual({ name: 'Renamed' })
    expect(params.destination).toBeUndefined()
    expect(original).toMatchObject({
      agentId: 'codex',
      rrule: saved.rrule,
      grace: '0',
      reuseSession: true
    })
  })
  it('refuses missing or duplicate owners instead of attributing rows to this host', () => {
    const automations = [savedAutomation()]
    const item = { automationId: automations[0]!.id, selector: { kind: 'self' } }
    expect(automationListSchema.safeParse({ automations }).success).toBe(false)
    expect(automationListSchema.safeParse({ automations, items: [] }).success).toBe(false)
    expect(automationListSchema.safeParse({ automations, items: [item, item] }).success).toBe(false)
    expect(
      automationListSchema.parse({ automations, items: [item] })[0]?.automation.futureField
    ).toBe('keep me')
  })
})

describe('mobile automation run failure copy', () => {
  afterEach(async () => {
    await activateMobileUiLocale('en')
  })

  it.each([
    [
      'fr',
      'L’hôte de l’automatisation n’est plus enregistré. Cette automatisation n’a donc plus d’hôte sur lequel s’exécuter.'
    ],
    [
      'ja',
      'オートメーションのホストは登録されていないため、このオートメーションを実行する場所がありません。'
    ]
  ] as const)(
    'localizes a coded host reply in %s without changing the stored text',
    async (locale, expected) => {
      const run = runSchema.parse({
        ...savedRun(),
        error: AUTOMATION_RUN_FAILURE_COPY.targetMissing,
        errorCode: 'targetMissing',
        errorParams: null
      })
      await activateMobileUiLocale(locale)
      expect(automationRunErrorText(run)).toBe(expected)
      expect(run.error).toBe(AUTOMATION_RUN_FAILURE_COPY.targetMissing)
      await activateMobileUiLocale('en')
      expect(automationRunErrorText(run)).toBe(AUTOMATION_RUN_FAILURE_COPY.targetMissing)
    }
  )

  it('localizes a stopped distro by name and falls back for unusable distro params', async () => {
    await activateMobileUiLocale('fr')
    const base = { ...savedRun(), error: 'Stored distro reason', errorCode: 'wslDistroStopped' }
    expect(
      automationRunErrorText(runSchema.parse({ ...base, errorParams: { distro: 'Ubuntu' } }))
    ).toBe(
      'La distribution WSL Ubuntu est arrêtée, donc cette exécution planifiée ne l’a pas démarrée. Démarrez la distribution ou utilisez Exécuter maintenant ; les exécutions suivantes ont lieu tant qu’elle tourne.'
    )
    for (const errorParams of [undefined, null, {}, { distro: 1 }]) {
      expect(automationRunErrorText(runSchema.parse({ ...base, errorParams }))).toBe(base.error)
    }
  })

  it('keeps stored errors for old hosts, nullable fields and future codes, and preserves no error', async () => {
    await activateMobileUiLocale('fr')
    for (const fields of [
      {},
      { errorCode: null, errorParams: null },
      { errorCode: 'futureReason' }
    ]) {
      const run = runSchema.parse({ ...savedRun(), error: 'Stored host reason', ...fields })
      expect(automationRunErrorText(run)).toBe('Stored host reason')
    }
    expect(
      automationRunErrorText(runSchema.parse({ ...savedRun(), errorCode: 'targetMissing' }))
    ).toBeNull()
  })

  it('uses whole setup-state sentences and keeps stored text when setup params are unusable', async () => {
    await activateMobileUiLocale('ja')
    const base = { ...savedRun(), error: 'Stored setup reason', errorCode: 'projectSetupNotReady' }
    for (const [setupState, expected] of [
      [
        'not-set-up',
        '選択したオートメーションのホストでは、プロジェクトがセットアップされていません。'
      ],
      ['setting-up', '選択したオートメーションのホストで、プロジェクトをまだセットアップ中です。'],
      ['error', '選択したオートメーションのホストで、プロジェクトのセットアップに失敗しました。'],
      [
        'unsupported',
        '選択したオートメーションのホストは、このプロジェクトをサポートしていません。'
      ]
    ]) {
      const run = runSchema.parse({ ...base, errorParams: { setupState } })
      expect(run.errorParams).toEqual({ setupState })
      expect(automationRunErrorText(run)).toBe(expected)
    }
    for (const errorParams of [
      undefined,
      null,
      {},
      { setupState: 'futureState' },
      { setupState: 1 }
    ]) {
      expect(automationRunErrorText(runSchema.parse({ ...base, errorParams }))).toBe(base.error)
    }
  })
})

it('translates known orphan reasons and leaves unknown host text intact', async () => {
  try {
    for (const issue of Object.values(AUTOMATION_ORPHAN_ISSUES)) {
      expect(automationOrphanIssueText(issue)).toBe(issue)
    }
    await activateMobileUiLocale('fr')
    expect(automationOrphanIssueText(AUTOMATION_ORPHAN_ISSUES.projectMissing)).toBe(
      'Son projet n’existe plus, il est donc impossible de déterminer son hôte.'
    )
    for (const unknown of ['Future host reason', 'toString']) {
      expect(automationOrphanIssueText(unknown)).toBe(unknown)
    }
  } finally {
    await activateMobileUiLocale('en')
  }
})
