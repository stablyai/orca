import { expect, it } from 'vitest'
import { translate } from '../i18n/mobile-i18n'
import { botLinkOpenFailureLine } from './bot-link-copy'

it('reports a deleted worktree as removed rather than offline', () => {
  expect(
    botLinkOpenFailureLine(translate, 'Studio', {
      reason: 'workspace-missing',
      beforeEffects: true,
      workspaceKind: 'git-worktree'
    })
  ).toBe('This chat’s workspace was deleted on Studio.')
  expect(
    botLinkOpenFailureLine(translate, 'Studio', {
      reason: 'unreachable',
      beforeEffects: false
    })
  ).toBe('Studio couldn’t open this chat. Try the link again.')
})
