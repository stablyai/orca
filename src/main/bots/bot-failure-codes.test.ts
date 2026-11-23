import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOT_FAILURE_COPY,
  BotFailureError,
  botFailureText,
  readBotFailure,
  type BotFailureCode
} from '../../shared/bots/bot-failure-copy'
import { LOOK_FAILURES, LOOK_FAILURE_CODES } from './bot-look-around-runner'
import { TIDY_UP_FAILURES, TIDY_UP_FAILURE_CODES } from './bot-memory-tidy-up'
import { botRunFailure } from './bot-run-failure-code'

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
