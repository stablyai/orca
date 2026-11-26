import type { ClaudeAccountRotationLimit } from '../../../shared/agent-accounts/claude/claude-account-rotation'
import { translateMain } from '../../i18n/main-i18n'
import type { RotationSwapKind } from './claude-rotation-state-files'

export type RotationNotice = { title: string; body: string }

export type RotationNoticeInput =
  | {
      type: 'switched'
      kind: RotationSwapKind
      limits: ClaudeAccountRotationLimit[]
      fromLabel: string | null
      toLabel: string | null
    }
  | { type: 'no-candidate'; limits: ClaudeAccountRotationLimit[] }
  | { type: 'reverted' | 'needs_repair' }

function describeLimits(limits: ClaudeAccountRotationLimit[]): string {
  return limits
    .map((limit) =>
      limit.window === 'five-hour'
        ? translateMain('accounts.claude.rotation.notice.fiveHourLimit', '5-hour {{percent}}%', {
            percent: limit.percent
          })
        : translateMain('accounts.claude.rotation.notice.weeklyLimit', 'weekly {{percent}}%', {
            percent: limit.percent
          })
    )
    .join(', ')
}

export function rotationNotice(input: RotationNoticeInput): RotationNotice {
  const title = translateMain('accounts.claude.rotation.notice.title', 'Claude account rotation')
  if (input.type === 'switched') {
    const unnamed = translateMain('accounts.claude.rotation.notice.unnamed', 'another account')
    const vars = {
      from: input.fromLabel ?? unnamed,
      to: input.toLabel ?? unnamed,
      limits: describeLimits(input.limits)
    }
    const body =
      input.kind === 'over'
        ? translateMain(
            'accounts.claude.rotation.notice.switchedOver',
            '{{from}} reached {{limits}}. Claude now uses {{to}}.',
            vars
          )
        : input.kind === 'prefer'
          ? translateMain(
              'accounts.claude.rotation.notice.switchedPreferred',
              'Claude moved from {{from}} back to {{to}}, which has a higher priority.',
              vars
            )
          : translateMain(
              'accounts.claude.rotation.notice.switchedSoonerReset',
              'Claude moved from {{from}} to {{to}}, whose weekly limit resets sooner.',
              vars
            )
    return { title, body }
  }
  if (input.type === 'no-candidate') {
    return {
      title,
      body: translateMain(
        'accounts.claude.rotation.notice.noCandidate',
        'Reached {{limits}}, but no other account is free to switch to. Close sessions on another account or wait for a reset.',
        { limits: describeLimits(input.limits) }
      )
    }
  }
  if (input.type === 'reverted') {
    return {
      title,
      body: translateMain(
        'accounts.claude.rotation.notice.reverted',
        'A running Claude session kept the old login, so the last switch was undone.'
      )
    }
  }
  return {
    title,
    body: translateMain(
      'accounts.claude.rotation.notice.needsRepair',
      'After a switch, a folder has no login or one for another account. Orca keeps its backups of both logins and pauses switching until that folder is signed in to one of the two accounts again.'
    )
  }
}
