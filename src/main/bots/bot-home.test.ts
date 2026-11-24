import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { botFolderName } from '../../shared/bots/bot-folder-name'
import { templateBotFolderName } from '../../shared/bots/bot-template-view'
import {
  assertBotOwnsHome,
  botsRootFolder,
  isBotsProjectGroup,
  localBotHomeFilesystem as fs,
  writeBotHome
} from './bot-home'

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'Reviewer',
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: 'fw-1',
    agent: 'claude',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('bot home', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-bot-home-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes the soul, memory and agent pointer files', async () => {
    const folder = join(root, 'reviewer')
    await writeBotHome(fs, folder, makeBot())

    expect((await readdir(folder)).sort()).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'MEMORY.md',
      'SOUL.md',
      'bot.json',
      'memory'
    ])
    expect(await readFile(join(folder, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
    expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toContain('You are Reviewer')
    expect(JSON.parse(await readFile(join(folder, 'bot.json'), 'utf8'))).toEqual({
      id: 'bot-1',
      name: 'Reviewer',
      agent: 'claude',
      avatar: null,
      members: []
    })
  })

  it('keeps the user’s soul and memory and rewrites only what Orca owns', async () => {
    const folder = join(root, 'reviewer')
    await writeBotHome(fs, folder, makeBot())
    await writeFile(join(folder, 'SOUL.md'), 'Terse and kind.\n')
    await writeFile(join(folder, 'MEMORY.md'), '- 2026-10-27 prefers small PRs\n')
    await writeFile(join(folder, 'memory', 'repos.md'), 'notes\n')
    await writeFile(join(folder, 'AGENTS.md'), 'hand edit\n')

    await writeBotHome(fs, folder, makeBot({ name: 'Critic', agent: 'codex' }))

    expect(await readFile(join(folder, 'SOUL.md'), 'utf8')).toBe('Terse and kind.\n')
    expect(await readFile(join(folder, 'MEMORY.md'), 'utf8')).toBe(
      '- 2026-10-27 prefers small PRs\n'
    )
    expect(await readFile(join(folder, 'memory', 'repos.md'), 'utf8')).toBe('notes\n')
    expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toContain('You are Critic')
    expect(JSON.parse(await readFile(join(folder, 'bot.json'), 'utf8')).agent).toBe('codex')
  })

  it('refuses only a home another bot owns', async () => {
    const folder = join(root, 'reviewer')
    await writeBotHome(fs, folder, makeBot())
    await expect(assertBotOwnsHome(fs, folder, 'bot-1')).resolves.toBeUndefined()
    await expect(assertBotOwnsHome(fs, join(root, 'missing'), 'bot-2')).resolves.toBeUndefined()
    await expect(writeBotHome(fs, folder, makeBot({ id: 'bot-2' }))).rejects.toThrow(
      'bot_folder_not_owned'
    )
  })

  it('reserves a folder once', async () => {
    const folder = join(root, 'bots', 'reviewer')
    expect(await fs.reserveDirectory(folder)).toBe(true)
    expect(await fs.reserveDirectory(folder)).toBe(false)
  })
})

describe('bot folder names', () => {
  it.each([
    ['Reviewer', 'reviewer'],
    ['PR Reviewer (Jane)', 'pr-reviewer-jane'],
    ['Café bot', 'cafe-bot'],
    ['João', 'joao'],
    ['Revisão de PRs', 'revisao-de-prs'],
    ['日本語', 'bot'],
    ['con', 'con-bot'],
    ['LPT1', 'lpt1-bot']
  ])('%s → %s', (name, folder) => {
    expect(botFolderName(name)).toBe(folder)
  })

  it("files a template's bot under the template's English name while it keeps the proposed name", () => {
    const folder = (botName: string) =>
      templateBotFolderName(botName, { name: 'Pull request review' }, 'PR 리뷰')
    expect(folder('PR 리뷰')).toBe('pull-request-review')
    expect(folder('PR 리뷰 2')).toBe('pull-request-review-2')
    expect(folder('우리 팀 PR 리뷰')).toBe('pr')
    expect(folder('Straße')).toBe('stra-e')
  })

  it('caps long names without a trailing dash', () => {
    const folder = botFolderName(`${'a'.repeat(39)} tail`)
    expect(folder).toBe('a'.repeat(39))
  })

  it.each(['Orca', 'orca-dev'])('keeps the %s profile on ~/.orca/bots', (profile) => {
    const appData = join('home', 'me', 'Library', 'Application Support')
    const home = join('home', 'me')
    expect(botsRootFolder({ userData: join(appData, profile), appData, home })).toBe(
      join('home', 'me', '.orca', 'bots')
    )
  })

  it.each([
    ['orcad under XDG_DATA_HOME', join('home', 'me', '.local', 'share', 'Orca')],
    ['a shared-home server', join('home', 'me', '.orca-0a1b2c3d')]
  ])('keeps %s on ~/.orca/bots', (_label, userData) => {
    const paths = {
      userData,
      appData: join('home', 'me', '.config'),
      home: join('home', 'me'),
      xdgDataHome: join('home', 'me', '.local', 'share')
    }
    expect(botsRootFolder(paths)).toBe(join('home', 'me', '.orca', 'bots'))
  })

  it('keeps an isolated data folder out of ~/.orca', () => {
    const paths = {
      userData: join('tmp', 'review617', 'profile'),
      appData: join('home', 'me', 'Library', 'Application Support'),
      home: join('home', 'me')
    }
    expect(botsRootFolder(paths)).toBe(join('tmp', 'review617', 'profile', 'bots'))
  })

  it('names only the local bots root group as the Bots group', () => {
    const root = join('home', 'me', '.orca', 'bots')
    expect(isBotsProjectGroup({ parentPath: root, connectionId: null }, root)).toBe(true)
    expect(isBotsProjectGroup({ parentPath: root, connectionId: 'ssh-1' }, root)).toBe(false)
    expect(isBotsProjectGroup({ parentPath: join('home', 'me'), connectionId: null }, root)).toBe(
      false
    )
  })
})
