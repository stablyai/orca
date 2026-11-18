import { afterEach, expect, it } from 'vitest'
import { activateMobileUiLocale, translate } from '../i18n/mobile-i18n'
import {
  botLinkMissingLine,
  botLinkOpenFailureLine,
  botLinkUpdateNeededLine
} from './bot-link-copy'

afterEach(() => activateMobileUiLocale('en'))

it('formats the update alert in the selected language, including the computer list', async () => {
  await activateMobileUiLocale('de')
  expect(botLinkUpdateNeededLine(translate, ['Studio', 'Laptop'])).toBe(
    'Aktualisiere Orca auf Studio und Laptop, um diesen Link zu öffnen.'
  )
  expect(botLinkMissingLine(translate)).toBe('Keiner deiner gekoppelten Computer hat diesen Bot.')
})

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
