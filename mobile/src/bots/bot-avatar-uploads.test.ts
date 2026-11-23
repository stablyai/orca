import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import { noteListedBots, useBotAvatarUpload } from './bot-avatar-uploads'

// Over half the undrawn budget each, so two undrawn pictures can't both stay.
const PNG = 'A'.repeat(5 * 1024 * 1024)
const PICTURE = `data:image/png;base64,${PNG}`

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
    const reads = () =>
      ['a', 'b', 'c'].map(
        (botId) =>
          client.requests.filter(
            (request) => JSON.stringify(request.args[1]) === JSON.stringify({ botId })
          ).length
      )
    let renderer!: ReactTestRenderer
    // A new generation remounts every avatar in one commit.
    const draw = async (ids: string[], generation = 0) => {
      act(() =>
        renderer.update(
          createElement(
            'View',
            null,
            ids.map((id) => createElement(Avatar, { key: `${generation}:${id}`, botId: id }))
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
    expect(shown.get('b')).toBe(PICTURE)
    expect(shown.get('c')).toBe(PICTURE)
    expect(reads()).toEqual([2, 1, 1])

    await answerNext()
    await draw(['a', 'b', 'c'], 1)
    expect([shown.get('a'), shown.get('b'), shown.get('c')]).toEqual([PICTURE, PICTURE, PICTURE])
    expect(reads()).toEqual([2, 1, 1])
    act(() => renderer.unmount())
  })
})
