import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import { noteListedBots, useBotAvatarUpload } from './bot-avatar-uploads'

// Over half the undrawn budget each, so two undrawn pictures can't both stay.
const PNG = 'A'.repeat(5 * 1024 * 1024)

describe('bot avatar uploads', () => {
  it('keeps drawn pictures and reads an undrawn one again once it was dropped past the budget', async () => {
    const client = createFakeRpcClient()
    const shown = new Map<string, string | null>()
    function Avatar({ botId }: { botId: string }) {
      shown.set(botId, useBotAvatarUpload(botId, `upload:${botId}`))
      return null
    }
    const settle = () => act(async () => {})
    const answerNext = async () => {
      await settle()
      client.requests.at(-1)?.resolve({ id: 'r', ok: true, result: { png: PNG } })
      await settle()
    }
    const readsOf = (botId: string) =>
      client.requests.filter((request) => (request.args[1] as { botId: string }).botId === botId)
        .length
    const draw = async (ids: string[]) => {
      act(() =>
        renderer.update(
          createElement(
            'View',
            null,
            ids.map((id) => createElement(Avatar, { key: id, botId: id }))
          )
        )
      )
      await settle()
    }
    noteListedBots(
      client,
      'host-1',
      ['a', 'b', 'c'].map((id) => ({ id, avatar: `upload:${id}` }))
    )
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement('View'))
    })

    await draw(['a', 'b'])
    await answerNext()
    await answerNext()
    await draw(['b'])
    await draw(['b', 'c'])
    await answerNext()
    await draw(['b'])
    await draw(['a', 'b', 'c'])

    expect(shown.get('b')).toBe(`data:image/png;base64,${PNG}`)
    expect(shown.get('c')).toBe(`data:image/png;base64,${PNG}`)
    expect([readsOf('a'), readsOf('b'), readsOf('c')]).toEqual([2, 1, 1])
    act(() => renderer.unmount())
  })
})
