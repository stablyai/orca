// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../src/shared/agent-session-journal-item-key.ts'
import { projectStructuredItemsToNativeChat } from '../../src/shared/structured-agent-session-projection.ts'
import { structuredAgentSessionStartFailure } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-failure-text.ts'
import { structuredAgentSessionStartFailureRow } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-start-failure-row.ts'
import { MessageRow } from '../../src/renderer/src/components/native-chat/NativeChatMessageRow.tsx'
import { i18n } from '../../src/renderer/src/i18n/i18n.ts'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('startup sign-in rows from host to renderer', () => {
  it.each([
    ['Grok', 'Connectez-vous à Grok avec `grok login` sur l’ordinateur qui exécute ce chat.'],
    [
      'Pi',
      'Connectez-vous à Pi en exécutant `pi` puis en utilisant `/login` sur l’ordinateur qui exécute ce chat.'
    ],
    [
      'OpenCode',
      'Connectez-vous à OpenCode avec `opencode auth login` sur l’ordinateur qui exécute ce chat.'
    ],
    ['OMP', 'Connectez-vous à OMP.']
  ])(
    'translates an actual %s startup row with its diagnostic and resend advice',
    async (agentName, guidance) => {
      await i18n.changeLanguage('fr')
      const detail = 'Provider diagnostic: {{agent}} must remain literal.'
      const startup = structuredAgentSessionStartFailure(
        {
          failure: {
            kind: 'notSignedIn',
            account: 'system',
            detail: { text: detail, audience: 'person' }
          }
        },
        { agentName }
      )
      const mutation = structuredAgentSessionStartFailureRow('generation', startup)
      if (mutation.kind !== 'item' || mutation.body.kind !== 'status') {
        throw new Error('Expected the startup writer to produce a status row')
      }
      expect(mutation.body.text).toContain('Then send your message again.')
      const [message] = projectStructuredItemsToNativeChat([
        {
          itemId: agentJournalItemKey(mutation.identity),
          sequence: 1,
          revision: 1,
          observedAt: 1,
          body: mutation.body,
          turnScope: mutation.turnScope
        }
      ])
      render(
        createElement(MessageRow, {
          message,
          agentName,
          expandSignal: false,
          onScrollMessageToTop: vi.fn()
        })
      )
      expect(
        screen.getByText(`${guidance} ${detail} Puis envoyez à nouveau votre message.`)
      ).toBeInTheDocument()
      expect(screen.queryByText(mutation.body.text)).toBeNull()
    }
  )
})
