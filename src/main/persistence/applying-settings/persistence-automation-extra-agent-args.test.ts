import {
  closeTestStores,
  testState,
  createStore,
  readDataFile,
  makeRepo
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  automationCanonicalLaunchSetup,
  automationTerminalLaunchInputs
} from '../../../shared/automation-launch-setup'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../../shared/agent-launch/startup/tui-agent-startup'
import {
  encodeAutomationLaunchEdit,
  foldAutomationSourceEdit,
  type AutomationSourceEdit,
  type AutomationLaunchEdit
} from '../../../shared/automation-launch-source-edits'

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const BASE = {
  name: 'Docs pass',
  prompt: 'Tidy docs',
  agentId: 'claude' as const,
  projectId: 'r1',
  workspaceMode: 'existing' as const,
  workspaceId: 'r1::/tmp/r1',
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: new Date('2026-05-13T00:00:00Z').getTime()
}

describe('automation extra agent args persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('stores the exact text and survives a reload', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const text = '  --model opus --add-dir "docs/my specs"  '
    const automation = store.createAutomation({ ...BASE, extraAgentArgs: text })

    expect(automation.extraAgentArgs).toBe(text)
    store.flush()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store just flushed this automation to the data file.
    const persisted = readDataFile() as { automations: { extraAgentArgs?: string }[] }
    expect(persisted.automations[0].extraAgentArgs).toBe(text)
    await closeTestStores()
    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0].extraAgentArgs).toBe(text)
  })

  it('preserves on omission, replaces, and clears with empty or whitespace text', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const { id } = store.createAutomation({ ...BASE, extraAgentArgs: '--model opus' })

    // Older clients omit extraAgentArgs from unrelated patches.
    expect(store.updateAutomation(id, { name: 'Renamed' }).extraAgentArgs).toBe('--model opus')
    expect(store.updateAutomation(id, { extraAgentArgs: '--effort high' }).extraAgentArgs).toBe(
      '--effort high'
    )
    expect(
      Object.hasOwn(store.updateAutomation(id, { extraAgentArgs: '  ' }), 'extraAgentArgs')
    ).toBe(false)
    store.updateAutomation(id, { extraAgentArgs: '--model opus' })
    expect(
      Object.hasOwn(store.updateAutomation(id, { extraAgentArgs: '' }), 'extraAgentArgs')
    ).toBe(false)
  })

  it('rejects invalid extras without changing the record', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    expect(() =>
      store.createAutomation({ ...BASE, extraAgentArgs: '--dangerously-skip-permissions' })
    ).toThrow('"--dangerously-skip-permissions"')
    const { id } = store.createAutomation({ ...BASE, extraAgentArgs: '--model opus' })
    expect(() => store.updateAutomation(id, { extraAgentArgs: '--resume x' })).toThrow('"--resume"')
    expect(() =>
      // @ts-expect-error -- the wire can carry null; the store must refuse it rather than clear.
      store.updateAutomation(id, { extraAgentArgs: null })
    ).toThrow('must be text')
    expect(store.listAutomations()[0].extraAgentArgs).toBe('--model opus')
  })

  it('validates the merged record so enabling Reuse with stored extras fails', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const { id } = store.createAutomation({ ...BASE, extraAgentArgs: '--model opus' })

    expect(() => store.updateAutomation(id, { reuseSession: true })).toThrow(
      'Extra arguments require a fresh session for every run.'
    )
    expect(() =>
      store.createAutomation({ ...BASE, reuseSession: true, extraAgentArgs: '--model opus' })
    ).toThrow('fresh session')
    expect(() => store.updateAutomation(id, { agentId: 'gemini' })).toThrow("aren't supported")
    expect(
      store.updateAutomation(id, { extraAgentArgs: '', reuseSession: true }).reuseSession
    ).toBe(true)
  })
  it('atomically saves Chat with retained Terminal extras and keeps legacy records Terminal after reload', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const legacy = store.createAutomation(BASE)
    const chat = store.createAutomation({
      ...BASE,
      reuseSession: true,
      launchSetupPatch: {
        surface: 'chat',
        arguments: { kind: 'legacy-extras', value: '--model opus' }
      }
    })
    expect(chat).toMatchObject({
      surface: 'chat',
      extraAgentArgs: '--model opus',
      launchSetup: { surface: 'chat', extraAgentArgs: '--model opus' }
    })
    expect(() =>
      store.updateAutomation(chat.id, { launchSetupPatch: { surface: 'terminal' } })
    ).toThrow('fresh session')
    expect(store.listAutomations().find((row) => row.id === chat.id)?.surface).toBe('chat')
    expect(() =>
      store.updateAutomation(chat.id, {
        extraAgentArgs: '',
        launchSetupPatch: { surface: 'terminal' }
      })
    ).toThrow('one launch setup')
    store.updateAutomation(chat.id, {
      reuseSession: false,
      launchSetupPatch: { surface: 'terminal', arguments: { kind: 'legacy-extras', value: '' } }
    })
    expect(store.listAutomations().find((row) => row.id === chat.id)).toMatchObject({
      surface: 'terminal'
    })
    store.flush()
    await closeTestStores()
    const reloaded = await createStore()
    expect(reloaded.listAutomations().find((row) => row.id === legacy.id)?.surface).toBeUndefined()
    expect(
      reloaded.listAutomations().find((row) => row.id === chat.id)?.extraAgentArgs
    ).toBeUndefined()
  })
  it('keeps sparse removals, full Arguments and hidden choices through old echoes and reload', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const created = store.createAutomation({
      ...BASE,
      launchSetupPatch: {
        choices: { model: 'sonnet', options: { fastMode: 'true' }, permissionMode: 'accept-edits' },
        arguments: { kind: 'value', value: '--verbose' }
      }
    })
    expect(created.launchSetup).toEqual({
      launchPreferences: {
        model: 'sonnet',
        options: { fastMode: 'true' },
        permissionMode: 'accept-edits'
      },
      agentArgs: '--verbose'
    })
    const echoed = store.updateAutomation(created.id, { extraAgentArgs: created.extraAgentArgs })
    expect(echoed.launchSetup).toEqual(created.launchSetup)
    const removed = store.updateAutomation(created.id, {
      launchSetupPatch: { choices: { model: null } }
    })
    expect(removed.launchSetup?.launchPreferences?.model).toBeNull()
    expect(removed.launchSetup?.agentArgs).toBe('--verbose')
    store.flush()
    await closeTestStores()
    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0].launchSetup).toEqual(removed.launchSetup)
    reloaded.updateSettings({ agentLaunchChoices: { claude: { model: 'opus' } } })
    const reopened = reloaded.listAutomations()[0]
    const plan = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: reopened.agentId,
        settings: reloaded.getSettings(),
        platform: 'linux',
        shell: 'posix',
        isRemote: false,
        ...automationTerminalLaunchInputs(reopened)
      }),
      prompt: 'Tidy docs',
      allowEmptyPromptLaunch: true
    })
    expect(plan?.launchCommand).toContain('opus')
    expect(plan?.launchCommand).not.toContain('sonnet')
    expect(readDataFile()).not.toHaveProperty('automations.0.launchSetup')
  })

  it('lets old edits retire only their published raw and owned domains', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const created = store.createAutomation({
      ...BASE,
      launchSetupPatch: {
        arguments: { kind: 'value', value: '--model sonnet --verbose' },
        choices: { options: { fastMode: 'true' }, permissionMode: 'accept-edits' }
      }
    })
    expect(created.extraAgentArgs).toContain('sonnet')
    const changed = store.updateAutomation(created.id, { extraAgentArgs: '--model opus' })
    expect(changed.launchSetup?.agentArgs).toContain('--model opus')
    expect(changed.launchSetup?.agentArgs).toContain('--verbose')
    expect(changed.launchSetup?.launchPreferences).toMatchObject({
      options: { fastMode: 'true' },
      permissionMode: 'accept-edits'
    })
    const cleared = store.updateAutomation(created.id, { extraAgentArgs: '' })
    expect(cleared.launchSetup?.agentArgs).toBe('--verbose')
    expect(cleared.launchSetup?.launchPreferences?.permissionMode).toBe('accept-edits')
  })

  it('distinguishes an explicit equal modern pick from an old echo', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const created = store.createAutomation({
      ...BASE,
      extraAgentArgs: '--model sonnet --add-dir docs'
    })
    const picked = store.updateAutomation(created.id, {
      launchSetupPatch: { choices: { model: 'sonnet' } }
    })
    expect(picked.launchSetup?.launchPreferences?.model).toBe('sonnet')
    expect(picked.launchSetup?.extraAgentArgs).toBe('--add-dir docs')
    expect(store.updateAutomation(created.id, { extraAgentArgs: '' }).launchSetup).toMatchObject({
      launchPreferences: {}
    })
  })

  it('replaces extras with full Args, supports all agents, and honors inherit on the latest owner', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const created = store.createAutomation({ ...BASE, extraAgentArgs: '--model opus' })
    const full = store.updateAutomation(created.id, {
      launchSetupPatch: { arguments: { kind: 'value', value: '--verbose' } }
    })
    expect(full.launchSetup).toEqual({ agentArgs: '--verbose' })
    store.updateAutomation(created.id, { extraAgentArgs: '--add-dir docs' })
    const inherited = store.updateAutomation(created.id, {
      launchSetupPatch: { arguments: { kind: 'inherit' } }
    })
    expect(inherited.launchSetup).toEqual({})
    const rebound = store.updateAutomation(created.id, {
      agentId: 'opencode',
      launchSetupPatch: {
        arguments: { kind: 'value', value: '--arbitrary-provider-argument' }
      }
    })
    expect(rebound.launchSetup?.agentArgs).toBe('--arbitrary-provider-argument')
    expect(rebound.launchSetup?.launchPreferences).toBeUndefined()
  })

  it('retains target-agent validation and visible extras when a rebind also changes surface', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const created = store.createAutomation({ ...BASE, extraAgentArgs: '--add-dir docs' })
    expect(() =>
      store.updateAutomation(created.id, {
        agentId: 'codex',
        launchSetupPatch: { surface: 'terminal' }
      })
    ).toThrow('extra arguments')
    expect(store.listAutomations()[0].agentId).toBe('claude')
    const supported = store.createAutomation({ ...BASE, extraAgentArgs: '--model sonnet' })
    expect(
      store.updateAutomation(supported.id, {
        agentId: 'codex',
        launchSetupPatch: { surface: 'terminal' }
      }).launchSetup
    ).toEqual({ surface: 'terminal', extraAgentArgs: '--model sonnet' })
    expect(
      store.updateAutomation(created.id, {
        agentId: 'opencode',
        launchSetupPatch: { arguments: { kind: 'value', value: '--new' } }
      }).launchSetup?.agentArgs
    ).toBe('--new')
  })

  it('retires a raw model through the shared control reconciler without dropping raw siblings', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const created = store.createAutomation({
      ...BASE,
      launchSetupPatch: {
        arguments: { kind: 'value', value: '--model sonnet --verbose' }
      }
    })
    const removed = store.updateAutomation(created.id, {
      launchSetupPatch: { choices: { model: null } }
    })
    expect(removed.launchSetup).toMatchObject({
      agentArgs: '--verbose',
      launchPreferences: { model: null }
    })
  })

  it('validates only the active surface consumption for reuse and validates surface switches atomically', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const chat = store.createAutomation({
      ...BASE,
      reuseSession: true,
      launchSetupPatch: {
        surface: 'chat',
        arguments: { kind: 'empty' },
        choices: { model: null }
      }
    })
    expect(chat.reuseSession).toBe(true)
    expect(() =>
      store.updateAutomation(chat.id, { launchSetupPatch: { surface: 'terminal' } })
    ).toThrow('fresh session')
    expect(() =>
      store.updateAutomation(chat.id, {
        launchSetupPatch: { arguments: { kind: 'value', value: '--model sonnet' } }
      })
    ).toThrow('fresh session')
    expect(store.listAutomations()[0].launchSetup).toEqual(chat.launchSetup)
    const inert = store.updateAutomation(chat.id, {
      launchSetupPatch: { arguments: { kind: 'value', value: '--verbose' } }
    })
    expect(inert.reuseSession).toBe(true)
  })

  it('copies canonical presence and bytes rather than a legacy projection', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const source = store.createAutomation({
      ...BASE,
      launchSetupPatch: {
        surface: 'chat',
        copy: {
          agentArgs: null,
          launchPreferences: { model: null, options: { effort: null } },
          extraAgentArgs: '--legacy-dormant-text'
        }
      }
    })
    const copy = store.createAutomation({
      ...BASE,
      creationKey: 'modern-copy',
      launchSetupPatch: { copy: source.launchSetup }
    })
    expect(copy.launchSetup).toEqual(source.launchSetup)
  })

  it.each([
    [
      { kind: 'choices', value: { model: 'opus' } },
      { kind: 'supplemental', value: '--model sonnet --add-dir fixtures' }
    ],
    [
      { kind: 'supplemental', value: '--model sonnet --add-dir fixtures' },
      { kind: 'choices', value: { model: 'opus' } }
    ]
  ] satisfies AutomationSourceEdit[][])(
    'preserves source order between model choices and supplemental text: %j',
    async (...edits) => {
      const store = await createStore()
      store.addRepo(makeRepo())
      const created = store.createAutomation({
        ...BASE,
        launchSetupPatch: {
          copy: {
            surface: 'terminal',
            launchPreferences: { model: 'sonnet' },
            extraAgentArgs: '--add-dir docs'
          }
        }
      })
      let setup = automationCanonicalLaunchSetup(created)
      let patch: AutomationLaunchEdit | undefined
      for (const edit of edits) {
        ;({ setup, patch } = foldAutomationSourceEdit('claude', setup, patch, edit))
      }
      const saved = store.updateAutomation(created.id, {
        launchSetupPatch: encodeAutomationLaunchEdit(patch ?? {}, 'terminal')
      })
      expect(saved.launchSetup).toEqual(setup)
      expect(saved.launchSetup?.extraAgentArgs).toBe(
        edits[1].kind === 'supplemental'
          ? '--model sonnet --add-dir fixtures'
          : '--add-dir fixtures'
      )
      store.flush()
      await closeTestStores()
      expect((await createStore()).listAutomations()[0].launchSetup).toEqual(setup)
    }
  )

  it.each([{ launchPreferences: { model: 'sonnet' } }, { agentArgs: '--verbose --model sonnet' }])(
    'retains a re-entered legacy model after an unrelated permission choice: %j',
    async (source) => {
      const store = await createStore()
      store.addRepo(makeRepo())
      const created = store.createAutomation({
        ...BASE,
        launchSetupPatch: {
          copy: {
            surface: 'terminal',
            ...source,
            extraAgentArgs: '--add-dir docs'
          }
        }
      })
      let setup = automationCanonicalLaunchSetup(created)
      let patch: AutomationLaunchEdit | undefined
      const edits: AutomationSourceEdit[] = [
        { kind: 'legacy', value: '--add-dir docs' },
        { kind: 'legacy', value: '--model opus --add-dir docs' },
        { kind: 'choices', value: { permissionMode: 'full-access' } }
      ]
      for (const edit of edits) {
        ;({ setup, patch } = foldAutomationSourceEdit('claude', setup, patch, edit))
      }
      const saved = store.updateAutomation(created.id, {
        launchSetupPatch: encodeAutomationLaunchEdit(patch ?? {}, 'terminal')
      })
      expect(saved.launchSetup).toEqual(setup)
      expect(saved.launchSetup?.extraAgentArgs).toBe('--model opus --add-dir docs')
      expect(saved.launchSetup?.launchPreferences).toEqual({ permissionMode: 'full-access' })
      store.flush()
      await closeTestStores()
      expect((await createStore()).listAutomations()[0].launchSetup).toEqual(setup)
    }
  )

  it('retains cumulative model retirement after later full Arguments no longer contain a model', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const created = store.createAutomation({
      ...BASE,
      launchSetupPatch: { choices: { model: 'sonnet', options: { fastMode: 'true' } } }
    })
    let setup = automationCanonicalLaunchSetup(created)
    let patch: AutomationLaunchEdit | undefined
    for (const value of ['--model opus', '--verbose']) {
      ;({ setup, patch } = foldAutomationSourceEdit('claude', setup, patch, {
        kind: 'arguments',
        value: { kind: 'value', value }
      }))
    }
    const saved = store.updateAutomation(created.id, {
      launchSetupPatch: encodeAutomationLaunchEdit(patch ?? {}, 'terminal')
    })
    expect(saved.launchSetup?.launchPreferences?.model).toBeUndefined()
    expect(saved.launchSetup?.agentArgs).toBe('--verbose')
    expect(saved.launchSetup?.launchPreferences).toEqual(setup.launchPreferences)
  })

  it('applies permission source edits to the latest old-writer model without replacing its raw field', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const created = store.createAutomation({
      ...BASE,
      launchSetupPatch: {
        arguments: { kind: 'value', value: '--verbose --model sonnet --permission-mode default' }
      }
    })
    const { patch } = foldAutomationSourceEdit(
      'claude',
      automationCanonicalLaunchSetup(created),
      undefined,
      { kind: 'choices', value: { permissionMode: 'full-access' } }
    )
    store.updateAutomation(created.id, { extraAgentArgs: '--model opus' })
    const saved = store.updateAutomation(created.id, {
      launchSetupPatch: encodeAutomationLaunchEdit(patch ?? {}, 'terminal')
    })
    expect(saved.launchSetup?.agentArgs).toContain('--model opus')
    expect(saved.launchSetup?.agentArgs).not.toContain('sonnet')
    expect(saved.launchSetup?.agentArgs).not.toContain('--permission-mode')
    expect(saved.launchSetup?.launchPreferences?.permissionMode).toBe('full-access')
  })
})
