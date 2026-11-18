import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { connectorRefResolver } from './connector-ref-resolution'
import type { ConnectorTransport } from './connector-machine'

// The cloud's answer to every find, and what was asked.
function cloudAnswering(answer: unknown, takesWorkspaces = true) {
  const asked: unknown[] = []
  const transport: ConnectorTransport = {
    call: async <TSchema extends z.ZodType>(_path: string, body: unknown, schema: TSchema) => {
      asked.push(body)
      return { ok: true as const, value: schema.parse(answer) }
    }
  }
  return {
    resolve: connectorRefResolver(transport, new AbortController().signal, takesWorkspaces),
    asked
  }
}

const found = (...matches: { ref: string; label: string; exact?: true }[]) => ({
  ok: true,
  result: { matches }
})

describe('connectorRefResolver', () => {
  it("asks the cloud's find for the role and takes its one exact match in the source", async () => {
    const { resolve, asked } = cloudAnswering(
      found(
        { ref: 'slack:T1:C1', label: '#eng', exact: true },
        { ref: 'slack:T1:C2', label: '#eng-infra' },
        { ref: 'linear:org-1:team:t1', label: 'ENG Engineering', exact: true }
      )
    )
    await expect(resolve('bot-1', 'slack', 'place', '#eng')).resolves.toEqual({
      ref: 'slack:T1:C1',
      label: '#eng'
    })
    expect(asked).toEqual([
      { v: 1, botId: 'bot-1', verb: 'find', ref: '#eng', args: { of: 'place' } }
    ])
  })

  it('lists the refs when no one match is exact, and says when nothing matches', async () => {
    const fuzzy = cloudAnswering(found({ ref: 'slack:T1:C2', label: '#eng-infra' }))
    await expect(fuzzy.resolve('bot-1', 'slack', 'place', '#en')).rejects.toThrow(
      '"#en" names no one place exactly; pass one of these refs:\nslack:T1:C2  #eng-infra'
    )
    const none = cloudAnswering(found())
    await expect(none.resolve('bot-1', 'slack', 'place', '#gone')).rejects.toThrow(
      'Nothing the bot reaches in slack matches "#gone"'
    )
    await expect(
      none.resolve('bot-1', 'github', 'subject', 'https://github.com/acme/gone/pull/8')
    ).rejects.toThrow(
      "acme/gone isn't among the repositories the Orca GitHub app can reach; add it with `orca bot connectors --offer github`."
    )
  })

  it('takes a whole workspace only from a cloud that matches one, never asking an older cloud', async () => {
    const workspace = { ref: 'linear:org-1:workspace', label: 'Acme', exact: true as const }
    const current = cloudAnswering(found(workspace))
    await expect(current.resolve('bot-1', 'linear', 'place', workspace.ref)).resolves.toEqual({
      ref: workspace.ref,
      label: 'Acme'
    })
    const older = cloudAnswering(found(workspace), false)
    await expect(older.resolve('bot-1', 'linear', 'place', workspace.ref)).rejects.toThrow(
      "can't listen in a whole workspace yet"
    )
    expect(older.asked).toEqual([])
  })

  it("passes the cloud's refusal on in its words", async () => {
    const { resolve } = cloudAnswering({
      ok: false,
      refusal: 'not_reachable',
      message: "The bot isn't there."
    })
    await expect(resolve('bot-1', 'slack', 'place', '#eng')).rejects.toThrow("The bot isn't there.")
  })

  it("names a ref given as input by the ref's own find, and keeps the ref when it can't", async () => {
    const thread = 'slack:T1:C1:1.2'
    const answers = [
      found({ ref: thread, label: thread, exact: true }),
      found({ ref: thread, label: '#orca' })
    ]
    const asked: unknown[] = []
    const transport: ConnectorTransport = {
      call: async <TSchema extends z.ZodType>(_path: string, body: unknown, schema: TSchema) => {
        asked.push(body)
        return { ok: true as const, value: schema.parse(answers.shift() ?? found()) }
      }
    }
    const resolve = connectorRefResolver(transport, new AbortController().signal, true)
    await expect(resolve('bot-1', 'slack', 'subject', thread)).resolves.toEqual({
      ref: thread,
      label: '#orca'
    })
    expect(asked[1]).toEqual({ v: 1, botId: 'bot-1', verb: 'find', ref: thread, args: {} })
    // No second answer: the label stays the ref, which a save drops.
    answers.push(found({ ref: thread, label: thread, exact: true }))
    await expect(resolve('bot-1', 'slack', 'subject', thread)).resolves.toEqual({
      ref: thread,
      label: thread
    })
  })
})
