// Sharing a bot: the one temporary candidate built from the owner's picks: the package value, the
// archive packed from it, and the summary read from it. Deleted on release or when it expires.
import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Bot } from '../../../shared/bot-types'
import {
  BOT_PACKAGE_PURPOSE_MAX,
  BOT_PACKAGE_SCHEMA_VERSION,
  BOT_PACKAGE_SETUP_NOTE_MAX,
  BotPackageV1Schema,
  type BotPackageV1,
  type BotShareCandidateSummary
} from '../../../shared/bots/bot-package'
import { botPackageName } from '../../../shared/bots/bot-share-status'
import { writeBotPackageArchive } from './bot-package-archive'
import { scanBotText } from '../../../shared/bots/bot-text-scan'
import {
  buildBotPackageContent,
  withoutHiddenCharacters,
  type BotPackageContent,
  type BotPackageRawFile
} from './bot-package-content'
import {
  sharerRawFiles,
  withoutRefusedSkills,
  writeContentFolder
} from './bot-package-content-files'
import { BOT_DISPLAY_NAME_MAX, isLandingText, landingLine } from './bot-package-transport'
import { availableParts, picked, sharedAutomationIds } from './bot-share-available'
import { deriveConnectors, type BotShareable } from './bot-share-sources'

/** The owner's picks: absent lists share everything but memory, which is off unless named. */
export type BotShareSelection = {
  skills?: readonly string[]
  tools?: readonly string[]
  schedules?: readonly string[]
  eventSuggestions?: readonly string[]
  memory?: readonly string[]
  purpose?: string
}

/** The bot.json for the owner's picks. */
export function botPackageFor(
  bot: Bot,
  shareable: BotShareable,
  selection: BotShareSelection
): BotPackageV1 {
  const strip = <T extends { automationId: string }>({ automationId: _id, ...part }: T) => part
  const schedules = picked(shareable.schedules, selection.schedules, (entry) => entry.automationId)
  const eventSuggestions = picked(
    shareable.eventSuggestions,
    selection.eventSuggestions,
    (entry) => entry.automationId
  )
  return BotPackageV1Schema.parse({
    schemaVersion: BOT_PACKAGE_SCHEMA_VERSION,
    name: bot.name,
    ...(shareable.avatar ? { avatar: shareable.avatar } : {}),
    purpose: landingLine(selection.purpose ?? shareable.purpose, BOT_PACKAGE_PURPOSE_MAX),
    agentHint: bot.agent,
    skills: picked(shareable.skills, selection.skills, (entry) => entry.name).map(({ name }) => ({
      name
    })),
    tools: picked(shareable.tools, selection.tools, (entry) => entry.name),
    connectors: deriveConnectors(bot, { schedules, eventSuggestions }).map((kind) => ({ kind })),
    schedules: schedules.map(strip),
    eventSuggestions: eventSuggestions.map(strip),
    memory: picked(shareable.memory, selection.memory ?? [], (entry) => entry.topic).map(
      ({ topic }) => ({ topic })
    )
  })
}

/** Files whose shared text isn't the home's (a SKILL.md rebuilt from its frontmatter): their line
 *  numbers aren't the home file's, so the dialog doesn't offer to open the home file at a line. */
function rewrittenPaths(content: BotPackageContent, raw: readonly BotPackageRawFile[]): string[] {
  return content.files
    .filter((file) => {
      const source = raw.find((entry) => entry.path === file.path)
      return !source || Buffer.from(source.bytes).toString('utf8') !== file.text
    })
    .map((file) => file.path)
}

/** The note as a link carries it. */
function cleanNote(note: string): string {
  return withoutHiddenCharacters(note.trim()).slice(0, BOT_PACKAGE_SETUP_NOTE_MAX)
}

const CANDIDATE_TTL_MS = 30 * 60 * 1000
const MAX_CANDIDATES = 8

type Candidate = {
  botId: string
  /** The picks it was built from, kept so a publish can remember them for Update link. */
  selection: BotShareSelection
  /** What it was built from, for showing each part's exact text. */
  shareable: BotShareable
  summary: BotShareCandidateSummary
  archivePath: string
  /** The value the archive was packed from: what every page shows for a picked part. */
  content: BotPackageContent
  expiresAt: number
  /** The last note applied for a publish, kept so a retry with it is the same publish. */
  noted?: { note: string; candidate: NotedCandidate }
}

/** A candidate as one publish sends it; `summary.candidateId` keys that publish's cloud calls. */
export type NotedCandidate = Omit<Candidate, 'expiresAt' | 'noted'>

/** One temporary candidate per Share dialog: built from the picks, published by its digest. */
export class BotShareCandidates {
  private readonly candidates = new Map<string, Candidate>()
  /** Every change runs here in turn, so none releases a candidate another is still writing. */
  private changes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now
  ) {}

  prepare(input: {
    bot: Bot
    shareable: BotShareable
    selection: BotShareSelection
    packageId: string
    /** Built in, so a candidate opened with the last published note digests as that version did. */
    setupNote?: string
  }): Promise<BotShareCandidateSummary> {
    return this.change(() => this.build(input))
  }

  private async build(input: Parameters<BotShareCandidates['prepare']>[0]) {
    await this.prune()
    // One candidate per bot: a rebuild (a changed tick, a reopened dialog) replaces the last one.
    const previous = [...this.candidates.entries()].filter(
      ([, entry]) => entry.botId === input.bot.id
    )
    await Promise.all(previous.map(([id]) => this.remove(id)))
    if (!isLandingText(input.bot.name, BOT_DISPLAY_NAME_MAX)) {
      throw new Error(
        "The bot's name has characters a link page can't show. Rename it to share it."
      )
    }
    const setupNote = cleanNote(input.setupNote ?? '')
    const withNote = (bot: BotPackageV1) =>
      setupNote ? BotPackageV1Schema.parse({ ...bot, setupNote }) : bot
    const { files: raw, refused } = await sharerRawFiles(
      input.shareable,
      withNote(botPackageFor(input.bot, input.shareable, input.selection))
    )
    // A picked skill that couldn't be read goes out of the manifest and the choices, with why; the
    // candidate keeps the bot's own view of its parts for opening them.
    const packed = withoutRefusedSkills(input.shareable, refused)
    const declared = withNote(botPackageFor(input.bot, packed, input.selection))
    const content = buildBotPackageContent({ bot: declared, files: raw })
    if (this.candidates.size >= MAX_CANDIDATES) {
      throw new Error('bot-share-candidate-limit')
    }
    const candidateId = randomUUID()
    const candidate = await this.pack(
      candidateId,
      join(this.root, candidateId),
      {
        botId: input.bot.id,
        selection: input.selection,
        shareable: input.shareable,
        summary: { packageId: input.packageId }
      },
      content,
      {
        leftOut: packed.leftOut,
        notIncluded: [...content.notIncluded],
        rewritten: rewrittenPaths(content, raw),
        available: await availableParts(packed, content),
        automationIds: sharedAutomationIds(input.shareable, input.selection)
      }
    )
    this.candidates.set(candidateId, candidate)
    return candidate.summary
  }

  /** The candidate with the note on screen: the same value, only the note scanned again. The reviewed
   *  candidate stays until released, so a refused or failed publish can retry; the same note gives the
   *  same noted candidate, a changed one a new id. Null once released or expired. */
  withNote(candidateId: string, note: string): Promise<NotedCandidate | null> {
    return this.change(() => this.note(candidateId, note))
  }

  private async note(candidateId: string, note: string): Promise<NotedCandidate | null> {
    const candidate = this.candidates.get(candidateId)
    if (!candidate || candidate.expiresAt <= this.now()) {
      return null
    }
    const setupNote = cleanNote(note)
    const { content, summary } = candidate
    if (setupNote === (content.bot.setupNote ?? '')) {
      return candidate
    }
    if (candidate.noted?.note === setupNote) {
      return candidate.noted.candidate
    }
    const { setupNote: _old, ...rest } = content.bot
    const bot = BotPackageV1Schema.parse(setupNote ? { ...rest, setupNote } : rest)
    const where = 'bot.json#setupNote'
    const flags = [
      ...content.flags.filter((flag) => flag.where !== where),
      ...scanBotText(setupNote).map(({ line, kind }) => ({ where, line, kind }))
    ]
    const notedId = randomUUID()
    const noted = await this.pack(
      notedId,
      join(this.root, candidateId, 'noted', notedId),
      candidate,
      Object.freeze({ ...content, bot: Object.freeze(bot), flags: Object.freeze(flags) }),
      summary
    )
    if (candidate.noted) {
      await rm(dirname(candidate.noted.candidate.archivePath), { recursive: true, force: true })
    }
    candidate.noted = { note: setupNote, candidate: noted }
    return noted
  }

  /** Packs a value's archive into `directory`; `parts` are read from what it was built from. */
  private async pack(
    candidateId: string,
    directory: string,
    from: {
      botId: string
      selection: BotShareSelection
      shareable: BotShareable
      summary: { packageId: string }
    },
    content: BotPackageContent,
    parts: Pick<
      BotShareCandidateSummary,
      'leftOut' | 'notIncluded' | 'rewritten' | 'available' | 'automationIds'
    >
  ): Promise<Candidate> {
    const { botId, selection, shareable } = from
    try {
      const { bot, flags } = content
      // The archive is packed from the value's bytes, so it holds exactly what the dialog shows.
      const staging = join(directory, 'content')
      await writeContentFolder(content, staging)
      const written = await writeBotPackageArchive({
        contentDirectory: staging,
        archivePath: join(directory, 'package.tar.gz'),
        packageId: from.summary.packageId,
        versionId: randomUUID(),
        name: botPackageName(botId),
        displayName: bot.name,
        description: bot.purpose
      })
      await rm(staging, { recursive: true, force: true })
      const expiresAt = this.now() + CANDIDATE_TTL_MS
      const summary: BotShareCandidateSummary = {
        candidateId,
        packageId: written.transport.packageId,
        versionId: written.transport.versionId,
        botDigest: written.transport.botDigest,
        archiveSha256: written.archiveSha256,
        compressedBytes: written.compressedBytes,
        fileCount: written.transport.files.length,
        totalBytes: written.transport.files.reduce((total, file) => total + file.size, 0),
        bot,
        files: written.transport.files.map(({ path, role, size, executable }) => ({
          path,
          role,
          size,
          executable
        })),
        leftOut: parts.leftOut,
        notIncluded: parts.notIncluded,
        rewritten: parts.rewritten,
        available: parts.available,
        automationIds: parts.automationIds,
        flags: [...flags],
        blocked: flags.some((flag) => flag.kind === 'secret'),
        expiresAt: new Date(expiresAt).toISOString()
      }
      return {
        botId,
        selection,
        shareable,
        summary,
        archivePath: written.archivePath,
        content,
        expiresAt
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  /** The live candidate and its archive; null once released or expired. */
  get(candidateId: string): Omit<Candidate, 'expiresAt'> | null {
    const candidate = this.candidates.get(candidateId)
    return candidate && candidate.expiresAt > this.now() ? candidate : null
  }

  release(candidateId: string): Promise<void> {
    return this.change(() => this.remove(candidateId))
  }

  dispose(): Promise<void> {
    return this.change(async () => {
      this.candidates.clear()
      await rm(this.root, { recursive: true, force: true })
    })
  }

  private change<T>(run: () => Promise<T>): Promise<T> {
    const done = this.changes.then(run)
    this.changes = done.catch(() => undefined)
    return done
  }

  private async remove(candidateId: string): Promise<void> {
    this.candidates.delete(candidateId)
    await rm(join(this.root, candidateId), { recursive: true, force: true })
  }

  /** Drops expired candidates and any folder the map doesn't know: on the first prepare, every
   *  folder an earlier run left, since no candidate outlives the app. */
  private async prune(): Promise<void> {
    const expired = [...this.candidates.entries()]
      .filter(([, candidate]) => candidate.expiresAt <= this.now())
      .map(([id]) => id)
    await Promise.all(expired.map((id) => this.remove(id)))
    const folders = await readdir(this.root).catch(() => [])
    const unknown = folders.filter((name) => !this.candidates.has(name))
    await Promise.all(
      unknown.map((name) => rm(join(this.root, name), { recursive: true, force: true }))
    )
  }
}
