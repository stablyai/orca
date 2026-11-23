// Sharing a bot by link: one link per bot, found by its package name (`bot-<id>`), so nothing on the
// bot records it. Publish creates or moves that link; Update link moves the link the owner sees and
// never makes a second one; Stop sharing revokes it.
import { randomUUID } from 'node:crypto'
import type { Bot } from '../../../shared/bot-types'
import type { BotShareCandidateSummary, BotSharePartFile } from '../../../shared/bots/bot-package'
import {
  botPackageName,
  botShareStatusOf,
  type BotOwnedShare,
  type BotShareStatus
} from '../../../shared/bots/bot-share-status'
import type { SkillCloudOperation } from '../../../shared/skills/sharing/skill-cloud-contract'
import { BOT_SHARE_ERRORS } from '../../../shared/bots/bot-share-errors'
import type { BotShareCandidates, BotShareSelection, NotedCandidate } from './bot-package-export'
import type {
  BotCloudShare,
  BotCloudVersion,
  BotShareClient,
  BotShareMoved
} from './bot-share-client'
import {
  BOT_SHARE_RECEIVE_ERRORS,
  type BotShareReview
} from '../../../shared/bots/bot-share-received'
import {
  fetchSharedBot,
  type BotShareDownloadPolicy,
  type FetchedSharedBot
} from './bot-share-receive'
import { buildBotPackageContent } from './bot-package-content'
import { archiveRawFiles } from './bot-package-content-files'
import { prepareRecipientContent, reviewOf, type BotRecipientContent } from './bot-share-recipient'
import { BotShareReviews } from './bot-share-reviews'
import { botSharePartFiles } from './bot-share-part-view'
import type { BotShareable } from './bot-share-sources'
import type { BotSharePicks } from '../../../shared/bots/bot-share-picks'
import type { BotSharePicksStore } from './bot-share-picks-store'

export type BotSharePublished = { share: BotCloudShare; version: BotCloudVersion }

/** A built candidate, and with `last` asked, the picks and note it was built from. */
export type BotSharePrepared = { candidate: BotShareCandidateSummary; last?: BotSharePicks }

export class BotShareService {
  private readonly reviews = new BotShareReviews()

  constructor(
    private readonly deps: {
      client: BotShareClient
      candidates: BotShareCandidates
      readShareable: (bot: Bot) => Promise<BotShareable>
      /** Each bot's last published picks; absent in tests that don't publish. */
      picks?: BotSharePicksStore
      /** Where a received bot downloads; absent where nothing is received (tests of sharing). */
      download?: BotShareDownloadPolicy
    }
  ) {}

  /** The candidate the owner reviews. A local preview uses a temporary package id until publish. With
   *  `last`, it is built from the picks and note the bot was last published with, when there are any. */
  async prepare(
    bot: Bot,
    selection: BotShareSelection,
    options: { setupNote?: string; last?: boolean; localOnly?: boolean } = {}
  ): Promise<BotSharePrepared> {
    const last = options.last ? ((await this.deps.picks?.get(bot.id)) ?? undefined) : undefined
    const found = options.localOnly
      ? null
      : await this.deps.client.findPackageId(botPackageName(bot.id))
    const candidate = await this.deps.candidates.prepare({
      bot,
      shareable: await this.deps.readShareable(bot),
      selection: last?.selection ?? selection,
      setupNote: last?.setupNote ?? options.setupNote,
      packageId: (found?.status === 'ok' && found.value) || randomUUID()
    })
    return last ? { candidate, last } : { candidate }
  }

  /** The exact text of one part of the bot, as the candidate was built from it. */
  view(bot: Bot, candidateId: string, part: string): Promise<BotSharePartFile[]> {
    const candidate = this.deps.candidates.get(candidateId)
    if (!candidate || candidate.botId !== bot.id) {
      throw new Error(BOT_SHARE_ERRORS.expired)
    }
    return botSharePartFiles(candidate.shareable, part, candidate)
  }

  /** A link's version, unpacked: the one it serves now, or `versionId` exactly. */
  fetch(shareId: string, versionId?: string): Promise<FetchedSharedBot | BotShareMoved | null> {
    if (!this.deps.download) {
      throw new Error('Receiving a bot needs the Orca desktop app.')
    }
    return fetchSharedBot(this.deps.client, this.deps.download, shareId, versionId)
  }

  /** What a link shares now, or exactly `versionId` (a copy's original), as Create would write it,
   *  kept here under the review's id. Null when the link was stopped or has moved past `versionId`. */
  async review(shareId: string, versionId?: string): Promise<BotShareReview | null> {
    const fetched = await this.fetch(shareId, versionId)
    if (!fetched || 'moved' in fetched) {
      return null
    }
    let recipient: BotRecipientContent
    try {
      const { read, version } = fetched
      const content = buildBotPackageContent({
        bot: read.bot,
        files: await archiveRawFiles(fetched.directory, read.transport)
      })
      recipient = prepareRecipientContent(
        content,
        {
          shareId,
          packageId: version.packageId,
          versionId: version.versionId,
          archiveSha256: read.archiveSha256,
          packageDigest: read.transport.botDigest,
          publisher: version.publisher.displayName,
          publishedAt: version.publishedAt
        },
        read.droppedKeys
      )
    } finally {
      await fetched.cleanup()
    }
    return reviewOf(recipient, this.reviews.put(recipient))
  }

  /** A review's content for Create, once the link is checked to still serve its version. */
  async reviewed(reviewId: string): Promise<BotRecipientContent> {
    const recipient = this.reviews.get(reviewId)
    if (!recipient) {
      throw new Error(BOT_SHARE_RECEIVE_ERRORS.expired)
    }
    const now = await this.deps.client.resolveShare(
      recipient.source.shareId,
      recipient.source.versionId
    )
    if (!now) {
      throw new Error(BOT_SHARE_RECEIVE_ERRORS.stopped)
    }
    if ('moved' in now || now.versionId !== recipient.source.versionId) {
      throw new Error(BOT_SHARE_RECEIVE_ERRORS.updated)
    }
    return recipient
  }

  /** The bot's display name a link serves now; null when it can't be read. */
  async displayName(shareId: string): Promise<string | null> {
    const version = await this.deps.client.resolveShare(shareId).catch(() => null)
    return version && !('moved' in version) ? version.manifest.displayName : null
  }

  /** Every live link the owner has made for bots. A link whose bot isn't among `localBots` carries the bot's name as the link serves it, read
   *  live; its package name stands in when that read fails. With `botId`, that bot's link (on any
   *  computer) also carries when its version was published and its digest. */
  async list(
    localBots: readonly Bot[],
    botId?: string
  ): Promise<SkillCloudOperation<BotOwnedShare[]>> {
    const shares = await this.deps.client.listShares()
    if (shares.status !== 'ok') {
      return shares
    }
    const local = new Set(localBots.map((bot) => botPackageName(bot.id)))
    const value = await Promise.all(
      shares.value.map(async (share) => {
        if (botId && share.name === botPackageName(botId)) {
          const pinned =
            share.canonical && share.pinnedVersionId
              ? await this.pinned(share.id, share.pinnedVersionId)
              : {}
          return local.has(share.name)
            ? { ...share, ...pinned }
            : { ...share, ...pinned, ...(await this.named(share.id)) }
        }
        if (local.has(share.name)) {
          return share
        }
        return { ...share, ...(await this.named(share.id)) }
      })
    )
    return { status: 'ok', value }
  }

  private async named(shareId: string): Promise<Pick<BotOwnedShare, 'displayName'>> {
    const displayName = await this.displayName(shareId)
    return displayName ? { displayName } : {}
  }

  /** A version never changes, so each is read from its link once. */
  private readonly pinnedVersions = new Map<
    string,
    Pick<BotOwnedShare, 'pinnedPublishedAt' | 'pinnedDigest'>
  >()

  /** When a link's version was published and its digest, read from the link; nothing when unread. */
  private async pinned(
    shareId: string,
    versionId: string
  ): Promise<Pick<BotOwnedShare, 'pinnedPublishedAt' | 'pinnedDigest'>> {
    const known = this.pinnedVersions.get(versionId)
    if (known) {
      return known
    }
    const version = await this.deps.client.resolveShare(shareId, versionId).catch(() => null)
    if (!version || 'moved' in version) {
      return {}
    }
    const pinned = { pinnedPublishedAt: version.publishedAt, pinnedDigest: version.packageDigest }
    this.pinnedVersions.set(versionId, pinned)
    return pinned
  }

  release(candidateId: string): Promise<void> {
    return this.deps.candidates.release(candidateId)
  }

  /** Publishes the reviewed candidate with the note on screen and points the bot's one link at it,
   *  making the link if the bot has none live. */
  async publish(
    bot: Bot,
    reviewedId: string,
    note: string
  ): Promise<SkillCloudOperation<BotSharePublished>> {
    const candidate = await this.noted(bot, reviewedId, note)
    const { candidateId } = candidate.summary
    const version = await this.publishCandidate(bot, candidate)
    if (version.status !== 'ok') {
      return version
    }
    const share = await this.deps.client.canonicalShare(
      version.value.packageId,
      version.value.versionId,
      `${candidateId}_share`
    )
    if (share.status !== 'ok') {
      return share
    }
    await this.remember(bot, candidate)
    await this.deps.candidates.release(reviewedId)
    return { status: 'ok', value: { share: share.value, version: version.value } }
  }

  /** *Update link*: moves the link the owner sees from the version it showed them. A stopped or
   *  moved link is an error, never a new link. */
  async update(
    bot: Bot,
    reviewedId: string,
    note: string,
    link: { shareId: string; expectedVersionId: string }
  ): Promise<SkillCloudOperation<BotSharePublished>> {
    const candidate = await this.noted(bot, reviewedId, note)
    const { candidateId } = candidate.summary
    const version = await this.publishCandidate(bot, candidate)
    if (version.status !== 'ok') {
      return version
    }
    const share = await this.deps.client.repointShare(
      link.shareId,
      { pinnedVersionId: version.value.versionId, expectedVersionId: link.expectedVersionId },
      `${candidateId}_update`
    )
    if (share.status !== 'ok') {
      return share
    }
    if (share.value === null) {
      throw new Error(BOT_SHARE_ERRORS.stopped)
    }
    if ('moved' in share.value) {
      throw new Error(BOT_SHARE_ERRORS.moved)
    }
    await this.remember(bot, candidate)
    await this.deps.candidates.release(reviewedId)
    return { status: 'ok', value: { share: share.value, version: version.value } }
  }

  /** Stops the link; false when it was already stopped. With the bot on this host, its stored picks
   *  go too, so sharing it again starts from the defaults. */
  async stop(shareId: string, botId?: string): Promise<SkillCloudOperation<boolean>> {
    const stopped = await this.deps.client.revokeShare(shareId)
    if (stopped.status === 'ok' && botId) {
      await this.deps.picks?.forget(botId).catch(() => undefined)
    }
    return stopped
  }

  /** Whether the bot is shared, and where: read live from the cloud each time. */
  async status(bot: Bot): Promise<SkillCloudOperation<BotShareStatus>> {
    const shares = await this.deps.client.listShares()
    return shares.status === 'ok'
      ? { status: 'ok', value: botShareStatusOf(shares.value, bot.id) }
      : shares
  }

  /** What the link now serves was built from these picks and this note: Update link starts there.
   *  A failed write only costs the next dialog its starting picks. */
  private async remember(bot: Bot, candidate: NotedCandidate): Promise<void> {
    const selection: BotSharePicks['selection'] = {}
    for (const part of ['skills', 'tools', 'schedules', 'eventSuggestions', 'memory'] as const) {
      const names = candidate.selection[part]
      if (names) {
        selection[part] = [...names]
      }
    }
    await this.deps.picks
      ?.set(bot.id, { selection, setupNote: candidate.content.bot.setupNote ?? '' })
      .catch(() => undefined)
  }

  /** The reviewed candidate with the note on screen; it stays reviewable until a publish succeeds. */
  private async noted(bot: Bot, reviewedId: string, note: string): Promise<NotedCandidate> {
    const candidate = await this.deps.candidates.withNote(reviewedId, note)
    if (!candidate || candidate.botId !== bot.id) {
      throw new Error(BOT_SHARE_ERRORS.expired)
    }
    return candidate
  }

  private async publishCandidate(
    bot: Bot,
    candidate: NotedCandidate
  ): Promise<SkillCloudOperation<BotCloudVersion>> {
    const secrets = candidate.content.flags.filter((flag) => flag.kind === 'secret')
    if (secrets.length > 0) {
      const inNote = secrets.every((flag) => flag.where === 'bot.json#setupNote')
      throw new Error(inNote ? BOT_SHARE_ERRORS.noteSecret : BOT_SHARE_ERRORS.blocked)
    }
    const found = await this.deps.client.findPackageId(botPackageName(bot.id))
    if (found.status !== 'ok') {
      return found
    }
    // The package id is in the archive: a package made since this preview means building it again.
    if (found.value !== null && found.value !== candidate.summary.packageId) {
      throw new Error(BOT_SHARE_ERRORS.prepareAgain)
    }
    const version = await this.deps.client.publishVersion({
      packageId: candidate.summary.packageId,
      archivePath: candidate.archivePath,
      archiveSha256: candidate.summary.archiveSha256,
      compressedBytes: candidate.summary.compressedBytes
    })
    if (version.status === 'ok' && version.value.packageDigest !== candidate.summary.botDigest) {
      throw new Error('bot-cloud-published-version-mismatch')
    }
    return version
  }
}
