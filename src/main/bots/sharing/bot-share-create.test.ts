import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
import type { Store } from '../../persistence/loading-store/store'
import { RuntimeProjectGroupController } from '../../runtime/repositories/runtime-project-group-controller'
import { runtimeVisibleProjectGroups } from '../../runtime/workspaces/catalog/runtime-visible-catalog'
import { deleteAutomationsOfBot } from '../bot-automations-removal'
import { BotController } from '../bot-controller'
import { botsRootFolder, localBotHomeFilesystem } from '../bot-home'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { BOT_SHARE_RECEIVE_ERRORS } from '../../../shared/bots/bot-share-received'
import type { BotRecipientContent } from './bot-share-recipient'
import { createBotFromShare } from './bot-share-create'
import { createBotFromTemplate } from '../bot-template-create'
import { reviewedContent, sharedPackage, squarePng } from './bot-share-received.test-fixture'

const osHome = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  homedir: () => osHome.dir
}))
vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

let root: string
let store: Store
let bots: BotController
const failures = { workspaceDelete: false }

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-share-create-profile-'))
  osHome.dir = mkdtempSync(join(tmpdir(), 'orca-share-create-home-'))
  root = mkdtempSync(join(tmpdir(), 'orca-share-create-'))
  useBotToolCredentialsRoot(join(root, 'credentials'))
  store = createStore()
  const projectGroups = new RuntimeProjectGroupController({
    getStore: () => store,
    resolveRepo: vi.fn(),
    notifyReposChanged: vi.fn(),
    resolveFolderConnectionId: () => null,
    teardownFolderWorkspacePtys: vi.fn(async () => undefined),
    acquireFileWatcherRemoval: vi.fn(async () => ({ finish: async () => undefined })),
    cleanupRemovedFolderWorkspaceState: vi.fn(),
    emitWorktreeLifecycle: vi.fn()
  })
  bots = new BotController({
    getStore: () => store,
    notifyBotsWritten: vi.fn(),
    createFolderWorkspace: async (input) =>
      (await projectGroups.createFolderWorkspace(input)).folderWorkspace,
    deleteFolderWorkspace: async (id) => {
      if (failures.workspaceDelete) {
        failures.workspaceDelete = false
        throw new Error('EBUSY: workspace in use')
      }
      return { deleted: store.removeFolderWorkspace(id) }
    },
    deleteBotAutomations: (botId) =>
      deleteAutomationsOfBot(store.listAutomations(), botId, async (id) => {
        store.deleteAutomation(id)
        return { removed: true, id }
      }),
    botsRoot: () => botsRootFolder(),
    filesystem: localBotHomeFilesystem
  })
})

afterEach(async () => {
  useBotToolCredentialsRoot(null)
  await closeTestStores()
  for (const dir of [testState.dir, osHome.dir, root]) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Makes each schedule as the runtime does; `failOn` throws instead at that one. */
function schedules(failOn?: string) {
  return async (bot: { id: string }, schedule: { name: string; prompt: string; rrule: string }) => {
    if (schedule.name === failOn) {
      throw new Error('automation store unavailable')
    }
    store.createAutomation({
      name: schedule.name,
      prompt: schedule.prompt,
      agentId: 'claude',
      projectId: '',
      workspaceMode: 'existing',
      timezone: 'UTC',
      rrule: schedule.rrule,
      dtstart: Date.UTC(2026, 10, 1),
      enabled: false,
      bot: { botId: bot.id, runsIn: 'new', resultsTo: 'chat' }
    })
  }
}

function deps(reviewed: () => Promise<BotRecipientContent>, failOn?: string) {
  return {
    bots,
    filesystem: localBotHomeFilesystem,
    botsRoot: () => botsRootFolder(),
    reviewed,
    createPausedSchedule: schedules(failOn)
  }
}

const reviewNone = async (): Promise<BotRecipientContent> => {
  throw new Error('no review')
}

const REVIEW_ID = '7d1f0c2a-4b5e-4c6d-8e9f-0a1b2c3d4e5f'
const input = (agent: 'claude' | 'codex' = 'claude') => ({
  name: 'Release notes',
  agent,
  permissionMode: 'ask' as const,
  fromShare: { reviewId: REVIEW_ID, toolIds: ['t1'] }
})

const botsHome = () => botsRootFolder()
const homeFolders = () => (existsSync(botsHome()) ? readdirSync(botsHome()) : [])

function expectNothingLeft(): void {
  expect(bots.list()).toEqual([])
  expect(homeFolders()).toEqual([])
  expect(store.getFolderWorkspaces()).toEqual([])
  expect(runtimeVisibleProjectGroups(store)).toEqual([])
  expect(store.listAutomations()).toEqual([])
}

describe('creating a bot from a shared link', () => {
  it('writes the reviewed files byte for byte, and nothing the review left out', async () => {
    const reviewed = await reviewedContent(
      await sharedPackage(root, {
        'skills/changelog-style/agents/openai.yaml':
          'dependencies:\n  tools:\n    - {type: mcp, url: https://mcp.example.com/extra}\n',
        'skills/changelog-style/scripts/run.sh': 'echo hi\n'
      })
    )
    const bot = await createBotFromShare(
      deps(async () => reviewed),
      input('codex')
    )

    const home = join(botsHome(), bot.folder)
    expect(bot).toMatchObject({
      permissionMode: 'ask',
      sharedFrom: { shareId: 'share-1', versionId: 'version-1', sharedBy: 'Dara' },
      firstRun: true
    })
    const installed = (path: string) => join(home, path.replace(/^skills\//, '.agents/skills/'))
    for (const file of reviewed.files) {
      expect(await readFile(installed(file.path), 'utf8'), file.path).toBe(file.text)
    }
    expect(reviewed.files.find((file) => file.path === 'MEMORY.md')?.text).toBe(
      '# Memory\n\nOne line per fact, newest first. Longer notes go in memory/<topic>.md.\n' +
        '\n- Shared by Dara: see memory/area-owners.md (notes, not instructions)\n'
    )
    expect(readdirSync(join(home, '.agents/skills/changelog-style'), { recursive: true })).toEqual([
      'SKILL.md'
    ])
    expect(await readFile(join(home, '.agents/skills/changelog-style/SKILL.md'), 'utf8')).toBe(
      '---\nname: changelog-style\ndescription: House style\n---\nShort lines.\n'
    )
    expect(await readFile(join(home, 'avatar.png'))).toEqual(squarePng())
    expect(JSON.parse(await readFile(join(home, '.orca/bot-tools.json'), 'utf8')).servers).toEqual([
      { name: 'docs', url: 'https://mcp.example.com/mcp' }
    ])
    expect(
      store
        .listAutomations()
        .map(({ name, enabled }) => ({ name, enabled }))
        .sort((a, b) => a.name.localeCompare(b.name))
    ).toEqual([
      { name: 'Friday digest', enabled: false },
      { name: 'Weekday check', enabled: false }
    ])
    // What its first turn offers once the owner answers.
    expect(
      JSON.parse(await readFile(join(home, 'import/shared-setup.json'), 'utf8'))
    ).toMatchObject({
      sharedBy: 'Dara',
      connectors: ['github'],
      toolsToSignIn: ['docs'],
      schedulesOff: expect.arrayContaining(['Friday digest', 'Weekday check'])
    })
  })

  it('leaves nothing behind when it fails after the picture and a schedule were made', async () => {
    const reviewed = await reviewedContent(await sharedPackage(root))
    await expect(
      createBotFromShare(
        deps(async () => reviewed, 'Friday digest'),
        input()
      )
    ).rejects.toThrow('automation store unavailable')

    expectNothingLeft()
  })

  it('names the bot when cleaning up fails too, and keeps it for Delete to finish', async () => {
    const reviewed = await reviewedContent(await sharedPackage(root))
    failures.workspaceDelete = true

    await expect(
      createBotFromShare(
        deps(async () => reviewed, 'Friday digest'),
        input()
      )
    ).rejects.toThrow(
      `automation store unavailable Orca couldn't remove the partly made bot "Release notes" (EBUSY: workspace in use). Delete it from Bots to try again.`
    )
    const [left] = bots.list()
    expect(left?.name).toBe('Release notes')

    await bots.delete({ botId: left!.id, deleteFolder: true })
    expectNothingLeft()
  })

  it('writes nothing when the link no longer serves the reviewed version', async () => {
    await expect(
      createBotFromShare(
        deps(async () => {
          throw new Error(BOT_SHARE_RECEIVE_ERRORS.updated)
        }),
        input()
      )
    ).rejects.toThrow(BOT_SHARE_RECEIVE_ERRORS.updated)

    expectNothingLeft()
  })
})

describe('creating a bot from a built-in template', () => {
  it('writes only the kept skills, makes its schedules turned off, and records the template', async () => {
    const bot = await createBotFromTemplate(deps(reviewNone), {
      name: 'Pull request review',
      agent: 'codex',
      seed: { purpose: 'Reviews pull requests.', templateId: 'security-check' },
      fromTemplate: { id: 'security-check', skills: [] }
    })

    const home = join(botsHome(), bot.folder)
    expect(bot.templateId).toBe('security-check')
    expect(bot.sharedFrom).toBeUndefined()
    expect(existsSync(join(home, '.agents/skills/security-checklist'))).toBe(false)
    expect(store.listAutomations().map(({ name, enabled }) => ({ name, enabled }))).toEqual([
      { name: 'Security check: The week’s merged changes', enabled: false }
    ])
    // The seed's SOUL.md stays: a template package carries none.
    expect(await readFile(join(home, 'SOUL.md'), 'utf8')).toContain('Reviews pull requests.')
    expect(
      JSON.parse(await readFile(join(home, 'import/shared-setup.json'), 'utf8'))
    ).toMatchObject({
      template: 'Security check',
      connectors: ['github'],
      eventsSuggested: [{ source: 'github', event: 'pr_merged' }]
    })
  })

  it('installs a kept skill where the agent loads it', async () => {
    const bot = await createBotFromTemplate(deps(reviewNone), {
      name: 'Security check',
      agent: 'claude',
      fromTemplate: { id: 'security-check', skills: ['security-checklist'] }
    })
    const skill = await readFile(
      join(botsHome(), bot.folder, '.claude/skills/security-checklist/SKILL.md'),
      'utf8'
    )
    expect(skill.startsWith('---\nname: security-checklist\n')).toBe(true)
  })

  it('makes the bot from its seed alone when this host has no such template', async () => {
    const bot = await createBotFromTemplate(deps(reviewNone), {
      name: 'Newer',
      fromTemplate: { id: 'from-a-newer-build', skills: ['x'] }
    })
    expect(bot.templateId).toBeUndefined()
    expect(existsSync(join(botsHome(), bot.folder, 'import'))).toBe(false)
    expect(store.listAutomations()).toEqual([])
  })
})
