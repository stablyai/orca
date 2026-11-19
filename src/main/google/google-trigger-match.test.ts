import { describe, expect, it } from 'vitest'
import type { AutomationGoogleTrigger } from '../../shared/automation-google-triggers'
import type { NewMail } from './google-gmail-changes'
import { gmailRuleMatches } from './google-trigger-match'

type GmailRule = Extract<AutomationGoogleTrigger, { source: 'gmail' }>

const rule = (from: string[]): GmailRule => ({
  id: 'on-mail',
  source: 'gmail',
  event: 'new_email',
  from
})

// senderVerified stands for Gmail's domain check passing; both sides share gmail.com, so it passes.
const mail = (from: string, extra: Partial<NewMail> = {}): NewMail => ({
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX'],
  from,
  to: 'ada@acme.dev',
  cc: '',
  subject: 'Hi',
  snippet: '',
  at: 0,
  senderVerified: true,
  ...extra
})

const fromBoss = (from: string) => gmailRuleMatches(rule(['boss@gmail.com']), mail(from), null)

describe('Gmail from= rules match the real sender address', () => {
  it('ignores an address written in the display name', () => {
    expect(fromBoss('"boss@gmail.com" <attacker@gmail.com>')).toBe(false)
    expect(fromBoss('boss@gmail.com <attacker@gmail.com>')).toBe(false)
    expect(fromBoss('"Boss, <boss@gmail.com> @ HQ" <attacker@gmail.com>')).toBe(false)
    expect(fromBoss('"\\"boss@gmail.com\\" <x>" <attacker@gmail.com>')).toBe(false)
    expect(fromBoss('attacker@gmail.com (boss@gmail.com)')).toBe(false)
    expect(fromBoss('boss@gmail.com attacker@gmail.com')).toBe(false)
    expect(fromBoss('<attacker@gmail.com (><boss@gmail.com>)>')).toBe(false)
  })

  it('matches the real address with any display name, bare, or uppercase', () => {
    expect(fromBoss('"Boss, <x@y.com> @ HQ" <boss@gmail.com>')).toBe(true)
    expect(fromBoss('attacker@gmail.com <boss@gmail.com>')).toBe(true)
    expect(fromBoss('Boss <boss@gmail.com>')).toBe(true)
    expect(fromBoss('boss@gmail.com')).toBe(true)
    expect(fromBoss('BOSS@Gmail.COM')).toBe(true)
    expect(fromBoss('The Boss <BOSS@GMAIL.COM>')).toBe(true)
    expect(fromBoss('<boss@gmail.com (Boss, <x@y.com>)>')).toBe(true)
    expect(fromBoss('boss@gmail.com, (no one)')).toBe(true)
    expect(gmailRuleMatches(rule(['gmail.com']), mail('"x@acme.com" <boss@gmail.com>'), null)).toBe(
      true
    )
    expect(gmailRuleMatches(rule(['acme.com']), mail('"x@acme.com" <boss@gmail.com>'), null)).toBe(
      false
    )
  })

  // Several From mailboxes have no single real sender for Gmail to verify, so none of them matches.
  it('never matches a From header with several addresses', () => {
    expect(fromBoss('boss@gmail.com, attacker@gmail.com')).toBe(false)
    expect(fromBoss('Boss <boss@gmail.com>, Other <other@gmail.com>')).toBe(false)
    expect(fromBoss('boss@gmail.com, "other"@gmail.com')).toBe(false)
    expect(fromBoss('boss@gmail.com, <attacker@gmail.com')).toBe(false)
    expect(fromBoss('boss@gmail.com, "attacker')).toBe(false)
  })

  it('still needs Gmail to verify the sender', () => {
    expect(
      gmailRuleMatches(
        rule(['boss@gmail.com']),
        mail('boss@gmail.com', { senderVerified: false }),
        null
      )
    ).toBe(false)
  })
})

describe('Gmail to= rules match real recipient addresses', () => {
  const toOps = (to: string) =>
    gmailRuleMatches(
      { id: 'on-mail', source: 'gmail', event: 'new_email', to: ['ops@acme.com'] },
      mail('boss@gmail.com', { to }),
      null
    )

  it('ignores addresses in display names and keeps every real one', () => {
    expect(toOps('"ops@acme.com" <ada@acme.dev>')).toBe(false)
    expect(toOps('"Lee, Kim" <lk@x.com>, Ops <OPS@acme.com>')).toBe(true)
  })
})
