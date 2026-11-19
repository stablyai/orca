import { describe, expect, it, vi } from 'vitest'
import { openHistorySessionPane } from './open-resumed-history-terminal'

vi.mock('expo-router', () => ({}))

describe('returning to a chat created by history continuation', () => {
  it.each([true, false])(
    'uses the existing session entry with shell return support %s',
    (returns) => {
      const navigation: string[] = []
      openHistorySessionPane({
        router: {
          back: () => {
            navigation.push('back')
          },
          replace: (href) => {
            navigation.push(`replace:${String(href)}`)
          }
        },
        sessionBelow: {
          onResumedTerminal: () => {
            throw new Error('A chat is not a terminal')
          }
        },
        shell: {
          returns: () => returns,
          open: (href) => {
            navigation.push(`shell:${href}`)
          }
        },
        hostId: 'host',
        executionHost: 'ssh:box',
        worktreeId: 'workspace',
        paneKey: 'chat:11111111-1111-4111-8111-111111111111',
        fromSession: true
      })
      expect(navigation).toEqual(
        returns
          ? [
              'shell:/h/host/session/workspace?paneKey=chat%3A11111111-1111-4111-8111-111111111111&executionHost=ssh%3Abox'
            ]
          : ['back']
      )
    }
  )
})
