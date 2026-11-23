import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOT_FAILURE_COPY,
  BotFailureError,
  botFailureEnglish,
  botFailureText,
  readBotFailure,
  type BotFailureCode
} from '../../shared/bots/bot-failure-copy'
import { LOOK_FAILURES, LOOK_FAILURE_CODES } from './bot-look-around-runner'
import { TIDY_UP_FAILURES, TIDY_UP_FAILURE_CODES } from './bot-memory-tidy-up'
import { botRunFailure } from './bot-run-failure-code'
import { BOT_OWNER_NOTICE_COPY, botOwnerNoticeText } from './bot-owner-notice-copy'
import { automationRunFailure } from '../../shared/automations/history/automation-run-failure-copy'
import { RemoteComputerRefusal, refusedAsk } from './bot-group-remote-refusal'

const ROOT = join(__dirname, '..', '..', '..')
const english = (_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (slot, name: string) =>
    values && Object.hasOwn(values, name) ? String(values[name]) : slot
  )

describe('bot failure codes', () => {
  it('ships every code in the desktop and phone English catalogs, word for word', () => {
    for (const catalog of [
      'src/renderer/src/i18n/locales/en.json',
      'mobile/src/i18n/locales/en.json'
    ]) {
      const en = JSON.parse(readFileSync(join(ROOT, catalog), 'utf8'))
      expect(en.bots.failures).toEqual(BOT_FAILURE_COPY)
    }
  })

  it('keeps the English main sent before codes', () => {
    expect(LOOK_FAILURES.timedOut).toBe('The last look was stopped after 10 min.')
    expect(TIDY_UP_FAILURES.tooLong).toBe(
      "The last tidy-up's MEMORY.md was over 200 lines and no shorter, so nothing changed."
    )
    expect(
      new BotFailureError('toolNameTakenByAgent', { agent: 'Codex', name: 'linear' }).message
    ).toBe(
      'Your Codex already has a tool named linear, which this bot gets too. Pick another name with --name.'
    )
    expect(new BotFailureError('groupImagesTooLarge', { totalMb: 70, maxMb: 64 }).message).toBe(
      'These images add up to 70 MB. A group message takes up to 64 MB.'
    )
    // A value holding a slot stays verbatim.
    expect(new BotFailureError('toolNotFound', { name: '{{name}}' }).message).toBe(
      'This bot has no tool named {{name}}.'
    )
  })

  it('keeps the owner notices, group errors and bot run skips in their old English', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'src/renderer/src/i18n/locales/en.json'), 'utf8'))
    expect(en.bots.notices).toEqual(BOT_OWNER_NOTICE_COPY)
    // No desktop surface (a headless host): the English the banner and push sent before.
    expect(botOwnerNoticeText('couldNotFinish', { bot: 'Ada' })).toBe("Ada couldn't finish")
    expect(botOwnerNoticeText('folderMissing', { automation: 'Triage' })).toBe(
      '"Triage" couldn\'t start because the bot\'s folder is missing.'
    )
    expect(botOwnerNoticeText('webhookRefusals', { automation: 'Deploys', refused: 12 })).toBe(
      '"Deploys" refused 12 calls in the last 10 minutes. If you don\'t expect them, pause it.'
    )
    expect(botOwnerNoticeText('accessAsked', { person: 'Sam', bot: 'Ada' })).toBe(
      'Sam asked to use Ada'
    )
    // A remote ask stores the English it did before, and its code renders back to it.
    for (const [refusal, stored] of [
      [
        new RemoteComputerRefusal('Studio Mac', 'It timed out', true),
        "Couldn't reach Studio Mac. It timed out. Post again to retry."
      ],
      [
        new RemoteComputerRefusal('Studio Mac', 'Not paired.', false),
        "Couldn't reach Studio Mac. Not paired."
      ]
    ] as const) {
      const { error, failure } = refusedAsk(refusal)
      expect(error).toBe(stored)
      expect(failure && botFailureEnglish(failure)).toBe(stored)
    }
    expect(new BotFailureError('groupReplierNotMember').message).toBe(
      'Choose a current room member in Room replies.'
    )
    expect(automationRunFailure('botPaused', { bot: 'Ada' })).toEqual({
      error: 'Ada is paused, so Orca skipped this run.',
      errorCode: 'botPaused',
      errorParams: { bot: 'Ada' }
    })
    expect(automationRunFailure('botsOff').error).toBe(
      'Bots are turned off in Settings, so Orca skipped this run.'
    )
  })

  it('translates what the wire carries back to the same English', () => {
    const error = new BotFailureError('groupPostFromHost', { host: 'Studio Mac' })
    const failure = readBotFailure(JSON.parse(JSON.stringify(error.data)).botFailure)
    expect(failure && botFailureText(failure, english)).toBe(error.message)
    expect(readBotFailure({ code: 'groupPostFromHost' })).toBeNull()
    expect(readBotFailure({ code: 'notACode' })).toBeNull()
  })

  it('reads every stored look and tidy-up failure back to its code', () => {
    for (const failure of [
      ...Object.values(LOOK_FAILURE_CODES),
      ...Object.values(TIDY_UP_FAILURE_CODES)
    ]) {
      const stored = english('', BOT_FAILURE_COPY[failure.code], failure.params)
      const read = botRunFailure(stored)
      expect(read?.code).toBe(failure.code)
      expect(read && botFailureText(read, english)).toBe(stored)
    }
    const skipped = `${BOT_FAILURE_COPY.tidyUpAllSkipped.replace(' ({{detail}})', '')} (line 3 is a decision)`
    expect(botRunFailure(skipped)).toEqual({
      code: 'tidyUpAllSkipped' satisfies BotFailureCode,
      params: { detail: 'line 3 is a decision' }
    })
    expect(botRunFailure('Something a newer Orca wrote.')).toBeUndefined()
  })
})
