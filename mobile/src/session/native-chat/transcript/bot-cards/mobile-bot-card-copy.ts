// The phone's words for the shared bot card copy: each id under its own key, with the shared English.
import {
  BOT_CREATE_OFFER_COPY as OFFER,
  type BotCreateOfferSay
} from '../../../../../../src/shared/bots/bot-create-offer-view'
import {
  BOT_REQUEST_CARD_COPY as REQUEST,
  type BotRequestCardSay
} from '../../../../../../src/shared/bots/bot-request-card-view'
import {
  BOT_TOOL_ADDED_CARD_COPY as TOOL,
  type BotToolAddedCardSay
} from '../../../../../../src/shared/bots/bot-tool-added-card-view'
import {
  WEBHOOK_CARD_COPY as WEBHOOK,
  type WebhookCardSay
} from '../../../../../../src/shared/bots/webhook-card-view'
import type { BotCardCopyValues } from '../../../../../../src/shared/native-chat/bot-cards/bot-card-copy'
import type { Translate } from '../../../../i18n/mobile-i18n'

type Pieces<Id extends string> = Record<Id, (t: Translate, values?: BotCardCopyValues) => string>

const REQUEST_PIECES: Pieces<keyof typeof REQUEST> = {
  notSentTo: (t) => t('chat.botCards.request.notSentTo', REQUEST.notSentTo),
  asked: (t) => t('chat.botCards.request.asked', REQUEST.asked),
  handedTo: (t) => t('chat.botCards.request.handedTo', REQUEST.handedTo),
  paused: (t, values) => t('chat.botCards.request.paused', REQUEST.paused, values),
  botsOff: (t) => t('chat.botCards.request.botsOff', REQUEST.botsOff),
  couldNotTake: (t, values) => t('chat.botCards.request.couldNotTake', REQUEST.couldNotTake, values)
}

export function mobileBotRequestSay(t: Translate): BotRequestCardSay {
  return (id, values) => REQUEST_PIECES[id](t, values)
}

const OFFER_PIECES: Pieces<keyof typeof OFFER> = {
  takesOverOne: (t) => t('chat.botCards.offer.takesOverOne', OFFER.takesOverOne),
  takesOverMany: (t, values) => t('chat.botCards.offer.takesOverMany', OFFER.takesOverMany, values),
  created: (t) => t('chat.botCards.offer.created', OFFER.created),
  createdAskedOne: (t) => t('chat.botCards.offer.createdAskedOne', OFFER.createdAskedOne),
  createdAskedMany: (t, values) =>
    t('chat.botCards.offer.createdAskedMany', OFFER.createdAskedMany, values),
  createdTookOverSome: (t, values) =>
    t('chat.botCards.offer.createdTookOverSome', OFFER.createdTookOverSome, values),
  createdTookOverOne: (t) => t('chat.botCards.offer.createdTookOverOne', OFFER.createdTookOverOne),
  createdTookOverMany: (t, values) =>
    t('chat.botCards.offer.createdTookOverMany', OFFER.createdTookOverMany, values),
  deleted: (t) => t('chat.botCards.offer.deleted', OFFER.deleted),
  nameTaken: (t, values) => t('chat.botCards.offer.nameTaken', OFFER.nameTaken, values),
  rename: (t) => t('chat.botCards.offer.rename', OFFER.rename),
  edit: (t) => t('chat.botCards.offer.edit', OFFER.edit),
  create: (t) => t('chat.botCards.offer.create', OFFER.create),
  open: (t) => t('chat.botCards.offer.open', OFFER.open),
  origin: (t, values) => t('chat.botCards.offer.origin', OFFER.origin, values),
  originTemplate: (t, values) =>
    t('chat.botCards.offer.originTemplate', OFFER.originTemplate, values),
  watches: (t) => t('chat.botCards.offer.watches', OFFER.watches),
  does: (t) => t('chat.botCards.offer.does', OFFER.does),
  reports: (t) => t('chat.botCards.offer.reports', OFFER.reports),
  willPropose: (t) => t('chat.botCards.offer.willPropose', OFFER.willPropose),
  takesOver: (t) => t('chat.botCards.offer.takesOver', OFFER.takesOver),
  template: (t) => t('chat.botCards.offer.template', OFFER.template)
}

export function mobileBotCreateOfferSay(t: Translate): BotCreateOfferSay {
  return (id, values) => OFFER_PIECES[id](t, values)
}

const TOOL_PIECES: Pieces<keyof typeof TOOL> = {
  heading: (t) => t('chat.botCards.toolAdded.heading', TOOL.heading),
  removed: (t) => t('chat.botCards.toolAdded.removed', TOOL.removed),
  remove: (t) => t('chat.botCards.toolAdded.remove', TOOL.remove)
}

export function mobileBotToolAddedSay(t: Translate): BotToolAddedCardSay {
  return (id) => TOOL_PIECES[id](t)
}

const WEBHOOK_PIECES: Pieces<keyof typeof WEBHOOK> = {
  title: (t) => t('chat.botCards.webhook.title', WEBHOOK.title),
  starts: (t, values) => t('chat.botCards.webhook.starts', WEBHOOK.starts, values),
  sampleNote: (t) => t('chat.botCards.webhook.sampleNote', WEBHOOK.sampleNote),
  sendSample: (t) => t('chat.botCards.webhook.sendSample', WEBHOOK.sendSample),
  secretAdd: (t) => t('chat.botCards.webhook.secretAdd', WEBHOOK.secretAdd),
  secretChange: (t, values) => t('chat.botCards.webhook.secretChange', WEBHOOK.secretChange, values)
}

export function mobileWebhookCardSay(t: Translate): WebhookCardSay {
  return (id, values) => WEBHOOK_PIECES[id](t, values)
}
