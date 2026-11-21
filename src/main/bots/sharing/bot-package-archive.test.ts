import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Automation } from '../../../shared/automations/automation-definition'
import { planBotFromPackage } from '../../../shared/bots/bot-package'
import { describeObservedSkillFile } from '../../skills/package-archive/skill-package-identity'
import { writeSkillTarGzip } from '../../skills/package-archive/skill-package-tar'
import { makeTestBot } from '../bot.test-fixture'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { readBotPackageArchive } from './bot-package-archive'
import {
  BOT_TRANSPORT_MANIFEST_PATH,
  botPackageDigest,
  parseBotTransportManifest
} from './bot-package-transport'
import { BotShareCandidates } from './bot-package-export'
import { readBotShareable } from './bot-share-sources'
import { within } from './bot-share-own-path'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bot-package-test-'))
  // Inline tool headers move to the credential store on read; never the real one.
  useBotToolCredentialsRoot(join(root, 'credentials'))
})

afterEach(async () => {
  useBotToolCredentialsRoot(null)
  await rm(root, { recursive: true, force: true })
})

const bot = makeTestBot({
  id: '3f2b6c1e-8d4a-4b7e-9c1f-5a6d7e8f9a0b',
  name: 'Release notes',
  agent: 'claude',
  avatar: 'mascot:H1',
  github: {}
})

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 'a1',
    name: 'Weekday release check',
    prompt: 'List PRs merged since yesterday.',
    precheck: null,
    agentId: 'claude',
    projectId: '',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'America/New_York',
    timezoneExplicit: true,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    bot: { botId: bot.id, runsIn: 'new', resultsTo: { channel: 'C0123', label: '#releases' } },
    ...overrides
  }
}

async function writeHome(home: string): Promise<void> {
  const files: [string, string][] = [
    ['SOUL.md', '# Release notes\n\nDrafts release notes from merged pull requests.\n'],
    [
      '.claude/skills/changelog-style/SKILL.md',
      '---\nname: changelog-style\ndescription: How release notes read\n---\nShort lines.\n'
    ],
    ['.claude/skills/changelog-style/scripts/collect.sh', '#!/bin/sh\necho merged\n'],
    ['memory/area-owners.md', 'Web: Dara\n'],
    ['memory/imported-hermes.md', 'From Hermes\n'],
    [
      '.orca/bot-tools.json',
      JSON.stringify({
        servers: [
          {
            name: 'docs',
            url: 'https://mcp.example.com/mcp?key=k1',
            headers: { Authorization: 'Bearer x' }
          },
          { name: 'local-db', command: '/usr/bin/db-mcp', args: [] }
        ]
      })
    ]
  ]
  for (const [path, text] of files) {
    await mkdir(join(home, path, '..'), { recursive: true })
    await writeFile(join(home, path), text)
  }
  await chmod(join(home, '.claude/skills/changelog-style/scripts/collect.sh'), 0o755)
}

describe('bot package export and archive', () => {
  it('leaves only the rebuilt candidate when a rebuild races a note', async () => {
    const home = join(root, 'home')
    await writeHome(home)
    const shareable = await readBotShareable({ bot, home, automations: [] })
    const candidatesRoot = join(root, 'candidates')
    await mkdir(join(candidatesRoot, 'left-by-an-earlier-run'), { recursive: true })
    const candidates = new BotShareCandidates(candidatesRoot)
    const input = { bot, shareable, selection: {}, packageId: 'pkg-1' }
    const reviewed = await candidates.prepare(input)

    const [noted, rebuilt] = await Promise.allSettled([
      candidates.withNote(reviewed.candidateId, 'Connect GitHub first.'),
      candidates.prepare(input)
    ])

    expect(noted).toMatchObject({ status: 'fulfilled' })
    if (rebuilt.status !== 'fulfilled') {
      throw rebuilt.reason
    }
    expect(candidates.get(reviewed.candidateId)).toBeNull()
    expect(await readdir(candidatesRoot)).toEqual([rebuilt.value.candidateId])
  })

  it('exports a bot whose plan maps back to the same parts', async () => {
    const home = join(root, 'home')
    await writeHome(home)
    const shareable = await readBotShareable({
      bot,
      home,
      automations: [
        automation({}),
        automation({
          id: 'a2',
          name: 'Summarize release PRs',
          prompt: 'Summarize the PR.',
          on: [
            {
              id: 'r1',
              source: 'github',
              event: 'pr_merged',
              in: ['acme/web'],
              textContains: 'release'
            }
          ],
          bot: { botId: bot.id, runsIn: 'new', resultsTo: 'thread' }
        }),
        automation({
          id: 'other',
          bot: { botId: 'someone-else', runsIn: 'new', resultsTo: 'chat' }
        })
      ]
    })
    const candidates = new BotShareCandidates(join(root, 'candidates'))
    const prepared = await candidates.prepare({
      bot,
      shareable,
      selection: { memory: ['area-owners'] },
      packageId: 'pkg-1'
    })
    const reviewedSoul = candidates.get(prepared.candidateId)?.content.files[0]
    // An edit after the review never reaches the link: the note goes onto the reviewed value.
    await writeFile(join(home, 'SOUL.md'), '# Release notes\n\nUnreviewed instruction.\n')
    const stored = await candidates.withNote(
      prepared.candidateId,
      ' Connect GitHub on the repo you ship from. '
    )
    if (!stored) {
      throw new Error('candidate missing')
    }
    const candidate = stored.summary
    const read = await readBotPackageArchive({
      archivePath: stored.archivePath,
      destinationDirectory: join(root, 'read'),
      expected: { botDigest: candidate.botDigest, archiveSha256: candidate.archiveSha256 }
    })
    expect(read.transport).toMatchObject({
      packageId: 'pkg-1',
      name: 'bot-3f2b6c1e8d4a4b7e9c1f5a6d7e8f9a0b',
      displayName: 'Release notes',
      description: 'Drafts release notes from merged pull requests.'
    })
    expect(read.droppedKeys).toEqual([])
    expect(reviewedSoul?.path).toBe('SOUL.md')
    expect(await readFile(join(root, 'read', 'SOUL.md'), 'utf8')).toBe(reviewedSoul?.text)
    expect(read.bot).toEqual({
      schemaVersion: 1,
      name: 'Release notes',
      avatar: { mascot: 'H1' },
      purpose: 'Drafts release notes from merged pull requests.',
      agentHint: 'claude',
      skills: [{ name: 'changelog-style' }],
      tools: [
        {
          id: 't1',
          name: 'docs',
          url: 'https://mcp.example.com/mcp',
          headerNames: ['Authorization']
        }
      ],
      connectors: [{ kind: 'github' }, { kind: 'slack' }],
      schedules: [
        {
          id: 's1',
          name: 'Weekday release check',
          prompt: 'List PRs merged since yesterday.',
          rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9',
          timezone: 'America/New_York',
          results: 'slack-channel'
        }
      ],
      eventSuggestions: [
        {
          id: 'e1',
          name: 'Summarize release PRs',
          prompt: 'Summarize the PR.',
          source: 'github',
          event: 'pr_merged',
          textContains: 'release',
          results: 'thread'
        }
      ],
      memory: [{ topic: 'area-owners' }],
      setupNote: 'Connect GitHub on the repo you ship from.'
    })
    expect(candidate.leftOut).toEqual([
      { kind: 'memory', name: 'imported-hermes', why: 'imported' },
      { kind: 'tool', name: 'local-db', why: 'command' }
    ])
    // A skill's script never goes out: a shared skill is its documents.
    expect(candidate.notIncluded).toEqual(['scripts/collect.sh in changelog-style'])
    expect(candidate.blocked).toBe(false)
    expect(
      planBotFromPackage(read.bot, read.transport.files, { agent: 'codex', toolIds: ['t1'] })
    ).toMatchObject({
      create: { name: 'Release notes', agent: 'codex', avatar: 'mascot:H1' },
      avatarImage: null,
      files: [
        { from: 'SOUL.md', to: 'SOUL.md', executable: false },
        { from: 'memory/area-owners.md', to: 'memory/area-owners.md', executable: false },
        {
          from: 'skills/changelog-style/SKILL.md',
          to: 'skills/changelog-style/SKILL.md',
          executable: false
        }
      ],
      tools: [{ id: 't1', name: 'docs' }],
      schedules: [{ id: 's1', enabled: false }],
      connectors: ['github', 'slack'],
      setupNote: 'Connect GitHub on the repo you ship from.'
    })
  })

  it('blocks a candidate whose text holds a secret', async () => {
    const home = join(root, 'home')
    await writeHome(home)
    await writeFile(join(home, 'SOUL.md'), '# Release notes\n\nPost with xoxb-1234567890-abcdef.\n')
    const shareable = await readBotShareable({ bot, home, automations: [] })
    const candidate = await new BotShareCandidates(join(root, 'candidates')).prepare({
      bot,
      shareable,
      selection: {},
      packageId: 'pkg-1'
    })
    expect(candidate.blocked).toBe(true)
    expect(candidate.flags).toContainEqual({ where: 'SOUL.md', line: 3, kind: 'secret' })
  })
})

describe('what a bot export may read', () => {
  it("shares the copy of a same-named skill that the bot's own agent loads", async () => {
    const home = join(root, 'home')
    await writeHome(home)
    await mkdir(join(home, '.agents/skills/changelog-style'), { recursive: true })
    await writeFile(
      join(home, '.agents/skills/changelog-style/SKILL.md'),
      '---\nname: changelog-style\ndescription: Codex copy\n---\n'
    )
    const codexBot = { ...bot, agent: 'codex' as const }
    const shareable = await readBotShareable({ bot: codexBot, home, automations: [] })
    expect(shareable.skills).toEqual([
      expect.objectContaining({ name: 'changelog-style', description: 'Codex copy' })
    ])
    expect(shareable.leftOut).toContainEqual({
      kind: 'skill',
      name: 'changelog-style',
      why: 'duplicate',
      from: '.claude/skills/changelog-style'
    })
  })

  it('shares a skill Claude reaches only through a link to the other agent folder', async () => {
    const home = join(root, 'home')
    await writeHome(home)
    await rm(join(home, '.claude/skills/changelog-style'), { recursive: true })
    await mkdir(join(home, '.agents/skills/triage'), { recursive: true })
    await writeFile(
      join(home, '.agents/skills/triage/SKILL.md'),
      '---\nname: triage\ndescription: Sort issues\n---\n'
    )
    await symlink(
      join(home, '.agents/skills/triage'),
      join(home, '.claude/skills/triage'),
      'junction'
    )
    for (const agent of ['claude', 'codex'] as const) {
      const shareable = await readBotShareable({ bot: { ...bot, agent }, home, automations: [] })
      expect(shareable.skills.map((skill) => skill.homePath)).toEqual(['.agents/skills/triage'])
      expect(shareable.leftOut.filter((entry) => entry.kind === 'skill')).toEqual([])
    }
  })

  it('treats a folder on another Windows drive as outside', () => {
    expect(within('C:\\orca\\bots\\a\\skills', 'D:\\elsewhere\\skill', win32)).toBe(false)
    expect(within('C:\\orca\\bots\\a\\skills', 'C:\\orca\\bots\\a\\skills\\x', win32)).toBe(true)
  })

  it('never follows a directory link out of the bot home', async () => {
    const home = join(root, 'home')
    await writeHome(home)
    const outside = join(root, 'outside')
    await mkdir(join(outside, 'secret-skill'), { recursive: true })
    await writeFile(
      join(outside, 'secret-skill', 'SKILL.md'),
      "---\nname: secret-skill\ndescription: Not the bot's\n---\n"
    )
    await rm(join(home, '.claude', 'skills'), { recursive: true })
    // A junction needs no Windows symlink privilege; POSIX ignores the type.
    await symlink(outside, join(home, '.claude', 'skills'), 'junction')
    const shareable = await readBotShareable({ bot, home, automations: [] })
    expect(shareable.skills).toEqual([])
    expect(shareable.leftOut).toContainEqual({
      kind: 'skill',
      name: '.claude/skills',
      why: 'linked'
    })
  })

  // File links need the Windows symlink privilege, which stock hosts lack.
  it.skipIf(process.platform === 'win32')('refuses a SOUL.md that is a link', async () => {
    const home = join(root, 'home')
    await writeHome(home)
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'roster.md'), 'Private client roster: Ada, Bo.\n')
    await rm(join(home, 'SOUL.md'))
    await symlink(join(outside, 'roster.md'), join(home, 'SOUL.md'))
    await expect(readBotShareable({ bot, home, automations: [] })).rejects.toThrow(
      'SOUL.md is missing or is a link'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'never reads a tools file through a file link',
    async () => {
      const outside = join(root, 'outside-tools')
      await mkdir(outside, { recursive: true })
      await writeFile(
        join(outside, 'bot-tools.json'),
        JSON.stringify({
          servers: [{ name: 'outside-tool', url: 'https://tools.example.com/mcp' }]
        })
      )
      const linkedFile = join(root, 'home-a')
      await writeHome(linkedFile)
      await rm(join(linkedFile, '.orca', 'bot-tools.json'))
      await symlink(join(outside, 'bot-tools.json'), join(linkedFile, '.orca', 'bot-tools.json'))
      const shareable = await readBotShareable({ bot, home: linkedFile, automations: [] })
      expect(shareable.tools).toEqual([])
      expect(shareable.leftOut).toContainEqual({
        kind: 'tool',
        name: '.orca/bot-tools.json',
        why: 'linked'
      })
    }
  )

  it('never reads a tools file through a directory link', async () => {
    const outside = join(root, 'outside-tools')
    await mkdir(outside, { recursive: true })
    await writeFile(
      join(outside, 'bot-tools.json'),
      JSON.stringify({ servers: [{ name: 'outside-tool', url: 'https://tools.example.com/mcp' }] })
    )
    const linkedFolder = join(root, 'home-b')
    await writeHome(linkedFolder)
    await rm(join(linkedFolder, '.orca'), { recursive: true })
    await symlink(outside, join(linkedFolder, '.orca'), 'junction')
    const shareable = await readBotShareable({ bot, home: linkedFolder, automations: [] })
    expect(shareable.tools).toEqual([])
    expect(shareable.leftOut).toContainEqual({
      kind: 'tool',
      name: '.orca/bot-tools.json',
      why: 'linked'
    })
  })

  it('never packs a skill nested inside another one, which is its own part', async () => {
    const home = join(root, 'home')
    await writeHome(home)
    const nested = join(home, '.claude/skills/changelog-style/archive/triage')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'SKILL.md'), '---\nname: triage\ndescription: Old copy\n---\n')
    await writeFile(join(nested, 'notes.md'), 'Old triage notes\n')
    await mkdir(join(home, 'skills/triage'), { recursive: true })
    await writeFile(
      join(home, 'skills/triage/SKILL.md'),
      '---\nname: triage\ndescription: Sort issues\n---\n'
    )
    const shareable = await readBotShareable({ bot, home, automations: [] })
    expect(shareable.leftOut).toContainEqual({
      kind: 'skill',
      name: 'triage',
      why: 'duplicate',
      from: '.claude/skills/changelog-style/archive/triage'
    })
    const candidate = await new BotShareCandidates(join(root, 'candidates')).prepare({
      bot,
      shareable,
      selection: {},
      packageId: 'pkg-1'
    })
    const paths = candidate.files.map((file) => file.path)
    expect(paths).toContain('skills/changelog-style/SKILL.md')
    expect(paths).toContain('skills/triage/SKILL.md')
    expect(paths.filter((path) => path.includes('/archive/'))).toEqual([])
  })

  it("keeps a SKILL.md that declares no skill as one of its parent skill's documents", async () => {
    const home = join(root, 'home')
    await writeHome(home)
    const references = join(home, '.claude/skills/changelog-style/references')
    await mkdir(references, { recursive: true })
    await writeFile(join(references, 'SKILL.md'), 'Plain notes on writing skills.\n')
    await writeFile(join(references, 'checklist.md'), 'Check the dates.\n')
    const candidate = await new BotShareCandidates(join(root, 'candidates')).prepare({
      bot,
      shareable: await readBotShareable({ bot, home, automations: [] }),
      selection: {},
      packageId: 'pkg-1'
    })
    const paths = candidate.files.map((file) => file.path)
    expect(paths).toContain('skills/changelog-style/references/SKILL.md')
    expect(paths).toContain('skills/changelog-style/references/checklist.md')
  })

  it('shares a skill whose nested skill holds a file over the size limit', async () => {
    const home = join(root, 'home')
    await writeHome(home)
    const nested = join(home, '.claude/skills/changelog-style/archive/bulky')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'SKILL.md'), '---\nname: bulky\ndescription: Big\n---\n')
    await writeFile(join(nested, 'data.bin'), Buffer.alloc(5 * 1024 * 1024))
    const candidate = await new BotShareCandidates(join(root, 'candidates')).prepare({
      bot,
      shareable: await readBotShareable({ bot, home, automations: [] }),
      selection: { skills: ['changelog-style'] },
      packageId: 'pkg-1'
    })
    const paths = candidate.files.map((file) => file.path)
    expect(paths).toContain('skills/changelog-style/SKILL.md')
    expect(paths.filter((path) => path.includes('/archive/'))).toEqual([])
  })

  it('leaves a binary skill file out, so a key in it never goes out', async () => {
    const home = join(root, 'home')
    await writeHome(home)
    await writeFile(
      join(home, '.claude/skills/changelog-style/blob.bin'),
      Buffer.from('xoxb-1234567890-abcdef\n\0')
    )
    const candidate = await new BotShareCandidates(join(root, 'candidates')).prepare({
      bot,
      shareable: await readBotShareable({ bot, home, automations: [] }),
      selection: {},
      packageId: 'pkg-1'
    })
    expect(candidate.notIncluded).toContain('blob.bin in changelog-style')
    expect(candidate.files.map((file) => file.path)).not.toContain(
      'skills/changelog-style/blob.bin'
    )
  })
})

const BOT_JSON = {
  schemaVersion: 1,
  name: 'Crafted',
  purpose: '',
  agentHint: 'claude',
  skills: [],
  tools: [],
  connectors: [],
  schedules: [],
  eventSuggestions: [],
  memory: []
}

/** An archive written straight to the tar writer, as a hostile sharer could. */
async function craftArchive(
  files: { path: string; text: string | Buffer; role: string; forgedIdentity?: string }[],
  digest?: string
): Promise<string> {
  const described = files
    .map((file) => ({
      file,
      identity: describeObservedSkillFile(file.path, Buffer.from(file.text), false)
    }))
    .sort((left, right) => (left.file.path < right.file.path ? -1 : 1))
  const inventory = described.map(({ file, identity }) => ({
    path: file.path,
    size: identity.size,
    executable: false,
    classification: identity.classification,
    sha256: identity.exactSha256,
    identitySha256: file.forgedIdentity ?? identity.identitySha256,
    role: file.role
  }))
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'bot',
      packageId: 'p1',
      versionId: 'v1',
      name: 'bot-crafted',
      displayName: 'Crafted',
      description: '',
      createdAt: '2026-11-08T00:00:00.000Z',
      files: inventory,
      botDigest: digest ?? botPackageDigest(inventory)
    })
  )
  const archivePath = join(root, `crafted-${Math.random().toString(36).slice(2)}.tar.gz`)
  await writeSkillTarGzip(archivePath, [
    {
      path: BOT_TRANSPORT_MANIFEST_PATH,
      size: manifest.length,
      executable: false,
      bytes: manifest
    },
    ...described.map(({ file }) => ({
      path: file.path,
      size: Buffer.from(file.text).length,
      executable: false,
      bytes: Buffer.from(file.text)
    }))
  ])
  return archivePath
}

const base = [
  { path: 'dev.orca.bot-sharing/bot.json', text: JSON.stringify(BOT_JSON), role: 'manifest' },
  { path: 'SOUL.md', text: '# Crafted\n', role: 'soul' }
]

describe('reading a bot archive', () => {
  const read = (archivePath: string) =>
    readBotPackageArchive({ archivePath, destinationDirectory: join(root, 'out') })

  it('reads a well-formed archive', async () => {
    await expect(read(await craftArchive(base))).resolves.toMatchObject({
      bot: { name: 'Crafted' }
    })
  })

  it('refuses agent config, aliases, undeclared parts, forged hashes, misnamed skills and fake avatars', async () => {
    const cases: [Promise<string>, string][] = [
      [
        craftArchive([...base, { path: '.mcp.json', text: '{}', role: 'soul' }]),
        'bot-package-path-not-allowed'
      ],
      [
        craftArchive([
          ...base,
          { path: 'Skills/x/SKILL.md', text: '---\nname: x\n---\n', role: 'skill:x' }
        ]),
        'bot-package-path-not-allowed'
      ],
      [
        craftArchive([...base, { path: 'memory/notes.md', text: 'note', role: 'memory' }]),
        'bot-package-undeclared-part'
      ],
      [craftArchive(base, '0'.repeat(64)), 'bot-package-digest-mismatch'],
      [
        craftArchive(base.map((file) => ({ ...file, forgedIdentity: 'f'.repeat(64) }))),
        'bot-package-identity-mismatch'
      ],
      [
        craftArchive([
          { ...base[0], text: JSON.stringify({ ...BOT_JSON, skills: [{ name: 'good' }] }) },
          base[1],
          { path: 'skills/good/SKILL.md', text: '---\nname: different\n---\n', role: 'skill:good' }
        ]),
        'bot-package-skill-name-mismatch'
      ],
      [
        craftArchive([
          { ...base[0], text: JSON.stringify({ ...BOT_JSON, avatar: { image: 'avatar.png' } }) },
          base[1],
          { path: 'avatar.png', text: Buffer.from('\0not a PNG'), role: 'avatar' }
        ]),
        'bot-package-avatar-invalid'
      ],
      [
        craftArchive([
          { ...base[0], text: JSON.stringify({ ...BOT_JSON, name: 'Someone else' }) },
          base[1]
        ]),
        'bot-package-identity-mismatch'
      ]
    ]
    for (const [archive, error] of cases) {
      await expect(read(await archive)).rejects.toThrow(error)
    }
  })
})

describe('the bot transport digest', () => {
  it('is the one the cloud computes for the same files', () => {
    // What the Orca Cloud connector service computes over these files.
    expect(
      botPackageDigest([
        {
          path: 'SOUL.md',
          role: 'soul',
          size: 30,
          executable: false,
          classification: 'text',
          sha256: '0'.repeat(64),
          identitySha256: 'a4c5460042db2a9ae9c1bd5b162064112e02f539c14796d1c7b9451f96b52b83'
        },
        {
          path: 'dev.orca.bot-sharing/bot.json',
          role: 'manifest',
          size: 2,
          executable: false,
          classification: 'text',
          sha256: '0'.repeat(64),
          identitySha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
        },
        {
          path: 'skills/notes/SKILL.md',
          role: 'skill:notes',
          size: 21,
          executable: false,
          classification: 'text',
          sha256: '0'.repeat(64),
          identitySha256: 'a1af8e8f451990ae82d10f2792bc39fceb1f78bac7712e2da44f6b3363091472'
        }
      ])
    ).toBe('fd68e847c6e36d4d82b19e37f745b76b349ead260de0cd56fd65562b21f2c26e')
    expect(
      describeObservedSkillFile('SOUL.md', Buffer.from('# Crafted\r\nShips on Fridays.\r\n'), false)
        .identitySha256
    ).toBe('a4c5460042db2a9ae9c1bd5b162064112e02f539c14796d1c7b9451f96b52b83')
  })
})

describe('the transport manifest', () => {
  const manifest = (displayName: string, description: string) => ({
    schemaVersion: 1,
    kind: 'bot',
    packageId: 'p1',
    versionId: 'v1',
    name: 'bot-crafted',
    displayName,
    description,
    createdAt: '2026-11-08T00:00:00.000Z',
    files: [],
    botDigest: '0'.repeat(64)
  })

  it('refuses a name or purpose the landing page could not show', () => {
    for (const [displayName, description] of [
      [`Orca${String.fromCodePoint(0x202e)} help`, ''],
      [`Release${String.fromCodePoint(0x061c)} notes`, ''],
      ['Release notes', `Drafts${String.fromCodePoint(0x061c)} notes`],
      ['x'.repeat(81), ''],
      ['Release notes', 'line one\nline two'],
      ['Release notes', 'x'.repeat(201)]
    ]) {
      expect(() => parseBotTransportManifest(manifest(displayName, description))).toThrow(
        'bot-package-transport-invalid'
      )
    }
  })
})
