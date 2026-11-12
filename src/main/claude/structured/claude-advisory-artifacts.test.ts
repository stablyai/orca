import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { createClaudeAdvisoryArtifactServer } from './claude-advisory-artifacts'

const HELLO_HASH = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const closers: (() => Promise<void>)[] = []

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000))
afterEach(() => vi.restoreAllMocks())

afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) {
    await close()
  }
})

function policy() {
  return {
    schema: 1,
    dataScope: 'published',
    sourcePin: 'a'.repeat(40),
    deadlineAt: 1_800_000_300_000,
    maxModelCalls: 4,
    artifacts: [{ path: 'src/hello.txt', sha256: HELLO_HASH, text: 'hello' }]
  }
}

async function connect(packet = policy(), publish?: (report: { status: string }) => Promise<void>) {
  const controller = new AbortController()
  const config = createClaudeAdvisoryArtifactServer(packet, sdk, controller.signal, publish)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await config.instance.connect(serverTransport)
  closers.push(() => config.instance.close())
  const client = new Client({ name: 'advisory-artifact-test', version: '1' })
  await client.connect(clientTransport)
  closers.push(() => client.close())
  return { client, controller }
}

describe('bounded advisory artifact access', () => {
  it('returns overlapping literal matches from the admitted snapshot', async () => {
    const { client } = await connect({
      ...policy(),
      artifacts: [
        {
          path: 'overlap.txt',
          text: 'aaa',
          sha256: '9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0'
        }
      ]
    })
    expect(
      await client.callTool({ name: 'search_artifacts', arguments: { query: 'aa' } })
    ).toMatchObject({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            matches: [
              { path: 'overlap.txt', offset: 0, text: 'aaa' },
              { path: 'overlap.txt', offset: 1, text: 'aaa' }
            ],
            truncated: false
          })
        }
      ]
    })
  })

  it('commits one advisory report and replays concurrent identical submissions without another effect', async () => {
    const published: unknown[] = []
    const { client } = await connect(policy(), async (report) => {
      published.push(report)
    })
    const body = {
      status: 'recommendation',
      recommendation: 'Check the empty input path.',
      evidence: ['src/hello.txt: hello'],
      uncertainty: 'No empty input fixture was supplied.',
      next_test: 'Run the existing empty input fixture.'
    }
    const responses = await Promise.all(
      [1, 2].map(() => client.callTool({ name: 'report_advice', arguments: body }))
    )
    expect(published).toEqual([body])
    expect(responses.map((response) => response.structuredContent)).toEqual([
      { state: 'submitted' },
      { state: 'submitted' }
    ])
    const changed = await client.callTool({ name: 'report_advice', arguments: { status: 'error' } })
    expect(changed.isError).toBe(true)
    expect(published).toEqual([body])
  })

  it('turns unsupported recommendations into inconclusive and never retries an ambiguous report effect', async () => {
    const published: unknown[] = []
    const { client } = await connect(policy(), async (report) => {
      published.push(report)
      throw new Error('private backend detail')
    })
    const body = { status: 'recommendation', recommendation: 'Unsupported claim.' }
    const first = await client.callTool({ name: 'report_advice', arguments: body })
    const replay = await client.callTool({ name: 'report_advice', arguments: body })
    expect(first.isError).toBe(true)
    expect(replay.isError).toBe(true)
    expect(JSON.stringify([first, replay])).not.toContain('private backend detail')
    expect(published).toEqual([{ status: 'inconclusive' }])
  })

  it('refuses report effects after cancellation', async () => {
    const published: unknown[] = []
    const { client, controller } = await connect(policy(), async (report) => {
      published.push(report)
    })
    controller.abort()
    const response = await client.callTool({
      name: 'report_advice',
      arguments: { status: 'inconclusive' }
    })
    expect(response.isError).toBe(true)
    expect(published).toEqual([])
  })

  it('serves only the admitted immutable snapshot and searches that same text', async () => {
    const packet = policy()
    const { client } = await connect(packet)
    packet.artifacts[0]!.text = 'replacement private text'
    const read = await client.callTool({
      name: 'read_artifact',
      arguments: { path: 'src/hello.txt', offset: 1, limit: 3 }
    })
    expect(read.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          path: 'src/hello.txt',
          sha256: HELLO_HASH,
          offset: 1,
          nextOffset: 4,
          text: 'ell'
        })
      }
    ])
    const search = await client.callTool({ name: 'search_artifacts', arguments: { query: 'ell' } })
    expect(search.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          matches: [{ path: 'src/hello.txt', offset: 1, text: 'hello' }],
          truncated: false
        })
      }
    ])
    const outside = await client.callTool({
      name: 'read_artifact',
      arguments: { path: '../private.txt' }
    })
    expect(outside.isError).toBe(true)
    expect(outside.content).toEqual([{ type: 'text', text: 'Artifact unavailable.' }])
  })

  it('refuses forged snapshots before exposing a server and revokes access on cancellation', async () => {
    const forged = policy()
    forged.artifacts[0]!.text = 'unapproved content'
    expect(() =>
      createClaudeAdvisoryArtifactServer(forged, sdk, new AbortController().signal)
    ).toThrow('Invalid advisory artifact snapshot.')
    const { client, controller } = await connect()
    controller.abort(new Error('private cancellation detail'))
    const result = await client.callTool({
      name: 'read_artifact',
      arguments: { path: 'src/hello.txt' }
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Advisor artifact access ended.' }])
  })

  it('refuses lossy UTF-8 and oversized byte snapshots even when their supplied hashes match', () => {
    for (const artifact of [
      {
        path: 'invalid.txt',
        text: '\ud800',
        sha256: '83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097'
      },
      {
        path: 'oversized.txt',
        text: 'é'.repeat(600_000),
        sha256: '888f8193e2abe8cc72be08fe956a2dbd00a001404f3b5c52576dfa6cef8f638f'
      }
    ]) {
      expect(() =>
        createClaudeAdvisoryArtifactServer(
          { ...policy(), artifacts: [artifact] },
          sdk,
          new AbortController().signal
        )
      ).toThrow('Invalid advisory artifact snapshot.')
    }
  })
})
