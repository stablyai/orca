import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHostedEnvironmentBuildFollowers,
  type HostedEnvironmentBuildFollowers
} from './hosted-environment-build-followers'
import {
  BUILD_ID,
  ENV_ID,
  buildView,
  line,
  ndjsonBody
} from './hosted-environment-fixtures.test-support'

const finishedBuild = async () => buildView({ status: 'succeeded' })

let followers: HostedEnvironmentBuildFollowers | null = null
afterEach(() => followers?.dispose())

async function drain(
  f: HostedEnvironmentBuildFollowers,
  client: Parameters<HostedEnvironmentBuildFollowers['poll']>[0]
): Promise<{ text: string; status: string | undefined; polls: number }> {
  let cursor = 0
  let text = ''
  for (let polls = 1; polls < 50; polls++) {
    const result = await f.poll(client, ENV_ID, BUILD_ID, cursor, 1_000)
    text += result.chunks.map((chunk) => chunk.data).join('')
    cursor = result.cursor
    if (result.done) {
      return { text, status: result.build?.status, polls }
    }
  }
  throw new Error('never finished')
}

describe('createHostedEnvironmentBuildFollowers', () => {
  it('long-polls the log and skips what a reconnect replays', async () => {
    let pass = 0
    const client = {
      getBuild: finishedBuild,
      openBuildEvents: async () =>
        pass++ === 0
          ? ndjsonBody([
              line({ type: 'build', build: buildView() }),
              line({ type: 'log', stream: 'stdout', data: 'one\n' }),
              line({ type: 'log', stream: 'stdout', data: 'tw' })
            ])
          : ndjsonBody([
              line({ type: 'build', build: buildView() }),
              line({ type: 'log', stream: 'stdout', data: 'one\ntwo\n' }),
              line({ type: 'log', stream: 'stderr', data: 'three\n' }),
              line({ type: 'build', build: buildView({ status: 'succeeded' }) }),
              line({ type: 'end' })
            ])
    }
    followers = createHostedEnvironmentBuildFollowers({ backoffMs: [1] })
    const result = await drain(followers, client)
    expect(result.text).toBe('one\ntwo\nthree\n')
    expect(result.status).toBe('succeeded')
  })

  it('reports a watch that gave up as done with its error', async () => {
    followers = createHostedEnvironmentBuildFollowers()
    const client = {
      getBuild: finishedBuild,
      openBuildEvents: async () => {
        const { HostedEnvironmentRequestError } = await import('./hosted-environment-client')
        throw new HostedEnvironmentRequestError('not_found', null, 'gone', 404)
      }
    }
    let cursor = 0
    for (;;) {
      const result = await followers.poll(client, ENV_ID, BUILD_ID, cursor, 1_000)
      cursor = result.cursor
      if (result.done) {
        expect(result.error).toBe('That environment or build no longer exists.')
        break
      }
    }
  })

  it('reuses one watch for concurrent pollers of the same build', async () => {
    let opens = 0
    const client = {
      getBuild: finishedBuild,
      openBuildEvents: async () => {
        opens++
        return ndjsonBody([
          line({ type: 'build', build: buildView({ status: 'failed', error: 'install_failed' }) }),
          line({ type: 'log', stream: 'stdout', data: 'x' }),
          line({ type: 'end' })
        ])
      }
    }
    followers = createHostedEnvironmentBuildFollowers()
    const [a, b] = await Promise.all([drain(followers, client), drain(followers, client)])
    expect(a.text).toBe('x')
    expect(b.text).toBe('x')
    expect(opens).toBe(1)
  })

  it('restarts from the first byte when a cursor outlived its follower', async () => {
    const client = {
      getBuild: finishedBuild,
      openBuildEvents: async () =>
        ndjsonBody([
          line({ type: 'build', build: buildView({ status: 'succeeded' }) }),
          line({ type: 'log', stream: 'stdout', data: 'a' }),
          line({ type: 'log', stream: 'stdout', data: 'b' }),
          line({ type: 'end' })
        ])
    }
    followers = createHostedEnvironmentBuildFollowers()
    // A CLI still holding cursor 40 from a follower that was swept and recreated.
    const result = await followers.poll(client, ENV_ID, BUILD_ID, 40, 1_000)
    expect(result.truncated).toBe(true)
    let text = result.chunks.map((chunk) => chunk.data).join('')
    let cursor = result.cursor
    let done = result.done
    while (!done) {
      const next = await followers.poll(client, ENV_ID, BUILD_ID, cursor, 1_000)
      expect(next.truncated).toBe(false)
      text += next.chunks.map((chunk) => chunk.data).join('')
      cursor = next.cursor
      done = next.done
    }
    expect(text).toBe('ab')
  })

  it('caps the log buffered across every follower', async () => {
    const chunk = 'x'.repeat(100)
    const client = {
      getBuild: finishedBuild,
      openBuildEvents: async () =>
        ndjsonBody([
          line({ type: 'build', build: buildView({ status: 'succeeded' }) }),
          ...Array.from({ length: 10 }, () => line({ type: 'log', stream: 'stdout', data: chunk })),
          line({ type: 'end' })
        ])
    }
    followers = createHostedEnvironmentBuildFollowers({ maxTotalBufferedChars: 500 })
    const other = 'bld_fedcba9876543210'
    // Let both watches finish before reading, so both buffers filled up.
    await followers.poll(client, ENV_ID, BUILD_ID, 0, 0)
    await followers.poll(client, ENV_ID, other, 0, 0)
    const [a, b] = await vi.waitFor(async () => {
      const both = await Promise.all([
        followers!.poll(client, ENV_ID, BUILD_ID, 0, 0),
        followers!.poll(client, ENV_ID, other, 0, 0)
      ])
      expect(both.every((result) => result.done)).toBe(true)
      return both
    })
    const total = [...a.chunks, ...b.chunks].reduce((sum, entry) => sum + entry.data.length, 0)
    expect(total).toBeLessThanOrEqual(500)
    expect(a.truncated || b.truncated).toBe(true)
    // Each keeps at least its newest chunk.
    expect(a.chunks.length).toBeGreaterThan(0)
    expect(b.chunks.length).toBeGreaterThan(0)
  })
})
