import { describe, expect, it, vi } from 'vitest'
import type { OrcaCloudEnvironmentBuildStreamEvent } from '../../../shared/hosted-sandbox/hosted-environment-api'
import { watchHostedEnvironmentBuild } from './hosted-environment-build-watch'
import { HostedEnvironmentRequestError } from './hosted-environment-client'
import {
  BUILD_ID,
  ENV_ID,
  buildView,
  line,
  ndjsonBody
} from './hosted-environment-fixtures.test-support'

const noSleep = async (): Promise<void> => undefined
// The build route the idle probe asks; by default the build already finished (no vouching).
const finishedBuild = async () => buildView({ status: 'succeeded' })

function summarize(events: OrcaCloudEnvironmentBuildStreamEvent[]): string[] {
  return events.map((event) => {
    switch (event.type) {
      case 'build':
        return `build:${event.build.status}`
      case 'log':
        return `log:${event.stream}:${event.data}`
      case 'error':
        return `error:${event.message}`
      case 'end':
      case 'reset':
      case 'reconnecting':
        return event.type
    }
  })
}

describe('watchHostedEnvironmentBuild', () => {
  it('parses lines split across chunks and stops at end once the build is final', async () => {
    const events: OrcaCloudEnvironmentBuildStreamEvent[] = []
    const openBuildEvents = vi.fn(async () =>
      ndjsonBody([
        line({ type: 'build', build: buildView() }).slice(0, 20),
        line({ type: 'build', build: buildView() }).slice(20),
        `${line({ type: 'log', stream: 'stdout', data: 'hello\n', at: 5 })}not json\n`,
        line({ type: 'log', stream: 'stderr', data: 'warn\n' }),
        line({ type: 'build', build: buildView({ status: 'succeeded' }) }),
        line({ type: 'end' })
      ])
    )
    const watch = watchHostedEnvironmentBuild({
      client: { openBuildEvents, getBuild: finishedBuild },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => events.push(event),
      sleep: noSleep
    })
    await watch.done
    expect(summarize(events)).toEqual([
      'build:running',
      'log:stdout:hello\n',
      'log:stderr:warn\n',
      'build:succeeded',
      'end'
    ])
    expect(events[1]).toMatchObject({ at: 5 })
    expect(openBuildEvents).toHaveBeenCalledTimes(1)
    expect(openBuildEvents).toHaveBeenCalledWith(ENV_ID, BUILD_ID, expect.any(AbortSignal))
  })

  it('reconnects with a reset when the stream drops before a final status', async () => {
    const events: OrcaCloudEnvironmentBuildStreamEvent[] = []
    const passes = [
      [
        line({ type: 'build', build: buildView() }),
        line({ type: 'log', stream: 'stdout', data: 'a' })
      ],
      // The control plane ended early (build still booting): follow again.
      [
        line({ type: 'build', build: buildView() }),
        line({ type: 'error', error: 'stream_failed' })
      ],
      [
        line({ type: 'build', build: buildView() }),
        line({ type: 'log', stream: 'stdout', data: 'ab' }),
        line({
          type: 'build',
          build: buildView({ status: 'failed', failedStep: 'install', error: 'install_failed' })
        }),
        line({ type: 'end' })
      ]
    ]
    const sleep = vi.fn(noSleep)
    let pass = 0
    const watch = watchHostedEnvironmentBuild({
      client: { openBuildEvents: async () => ndjsonBody(passes[pass++]), getBuild: finishedBuild },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => events.push(event),
      sleep
    })
    await watch.done
    expect(summarize(events)).toEqual([
      'build:running',
      'log:stdout:a',
      'reconnecting',
      'reset',
      'build:running',
      'reconnecting',
      'reset',
      'build:running',
      'log:stdout:ab',
      'build:failed',
      'end'
    ])
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('treats an end before a final status as a drop', async () => {
    const events: OrcaCloudEnvironmentBuildStreamEvent[] = []
    let pass = 0
    const watch = watchHostedEnvironmentBuild({
      client: {
        getBuild: finishedBuild,
        openBuildEvents: async () =>
          ndjsonBody(
            pass++ === 0
              ? [
                  line({ type: 'build', build: buildView({ status: 'starting' }) }),
                  line({ type: 'end' })
                ]
              : [
                  line({ type: 'build', build: buildView({ status: 'canceled' }) }),
                  line({ type: 'end' })
                ]
          )
      },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => events.push(event),
      sleep: noSleep
    })
    await watch.done
    expect(summarize(events)).toEqual([
      'build:starting',
      'reconnecting',
      'reset',
      'build:canceled',
      'end'
    ])
  })

  it('reconnects after the idle timeout when the build route says the build finished', async () => {
    const events: OrcaCloudEnvironmentBuildStreamEvent[] = []
    let pass = 0
    const watch = watchHostedEnvironmentBuild({
      client: {
        getBuild: finishedBuild,
        openBuildEvents: async (_env, _build, signal) =>
          pass++ === 0
            ? ndjsonBody([line({ type: 'build', build: buildView() })], { hang: true, signal })
            : ndjsonBody([
                line({ type: 'build', build: buildView({ status: 'succeeded' }) }),
                line({ type: 'end' })
              ])
      },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => events.push(event),
      idleTimeoutMs: 30,
      sleep: noSleep
    })
    await watch.done
    expect(summarize(events)).toEqual([
      'build:running',
      'reconnecting',
      'reset',
      'build:succeeded',
      'end'
    ])
  })

  it('gives up on a final refusal and after repeated drops without progress', async () => {
    const refused: OrcaCloudEnvironmentBuildStreamEvent[] = []
    await watchHostedEnvironmentBuild({
      client: {
        getBuild: finishedBuild,
        openBuildEvents: async () => {
          throw new HostedEnvironmentRequestError('not_found', null, 'gone', 404)
        }
      },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => refused.push(event),
      sleep: noSleep
    }).done
    expect(summarize(refused)).toEqual(['error:That environment or build no longer exists.'])

    const flaky: OrcaCloudEnvironmentBuildStreamEvent[] = []
    const openBuildEvents = vi.fn(async () => {
      throw new HostedEnvironmentRequestError('unavailable', null, 'down')
    })
    await watchHostedEnvironmentBuild({
      client: { openBuildEvents, getBuild: finishedBuild },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => flaky.push(event),
      maxStalledReconnects: 3,
      sleep: noSleep
    }).done
    expect(openBuildEvents).toHaveBeenCalledTimes(4)
    expect(flaky.map((event) => event.type)).toEqual([
      'reconnecting',
      'reconnecting',
      'reconnecting',
      'error'
    ])
  })

  it('stops quietly on stop() while the stream is open', async () => {
    const events: OrcaCloudEnvironmentBuildStreamEvent[] = []
    const watch = watchHostedEnvironmentBuild({
      client: {
        getBuild: finishedBuild,
        openBuildEvents: async (_env, _build, signal) =>
          ndjsonBody([line({ type: 'build', build: buildView() })], { hang: true, signal })
      },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => {
        events.push(event)
        watch.stop()
      },
      sleep: noSleep
    })
    await watch.done
    expect(summarize(events)).toEqual(['build:running'])
  })

  it('drops a line longer than the bound instead of buffering it', async () => {
    const events: OrcaCloudEnvironmentBuildStreamEvent[] = []
    const huge = 'x'.repeat(1024 * 1024 + 10)
    await watchHostedEnvironmentBuild({
      client: {
        getBuild: finishedBuild,
        openBuildEvents: async () =>
          ndjsonBody([
            huge,
            `${huge}\n`,
            line({ type: 'build', build: buildView({ status: 'succeeded' }) }),
            line({ type: 'end' })
          ])
      },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => events.push(event),
      sleep: noSleep
    }).done
    expect(summarize(events)).toEqual(['build:succeeded', 'end'])
  })

  it('treats heartbeats as liveness and never forwards them', async () => {
    const events: OrcaCloudEnvironmentBuildStreamEvent[] = []
    const getBuild = vi.fn(finishedBuild)
    const encoder = new TextEncoder()
    const openBuildEvents = vi.fn(async () => {
      let beats = 0
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(line({ type: 'build', build: buildView() })))
        },
        // Six heartbeats 15 ms apart span three idle windows of 30 ms without a single log line.
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 15))
          if (beats++ < 6) {
            controller.enqueue(encoder.encode(line({ type: 'heartbeat', at: beats })))
            return
          }
          controller.enqueue(
            encoder.encode(
              line({ type: 'build', build: buildView({ status: 'succeeded' }) }) +
                line({ type: 'end' })
            )
          )
          controller.close()
        }
      })
    })
    await watchHostedEnvironmentBuild({
      client: { openBuildEvents, getBuild },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => events.push(event),
      idleTimeoutMs: 30,
      sleep: noSleep
    }).done
    expect(summarize(events)).toEqual(['build:running', 'build:succeeded', 'end'])
    expect(openBuildEvents).toHaveBeenCalledTimes(1)
    expect(getBuild).not.toHaveBeenCalled()
  })

  it('keeps a silent stream open while the build route says the build is running', async () => {
    const events: OrcaCloudEnvironmentBuildStreamEvent[] = []
    const getBuild = vi.fn(async () => buildView())
    const encoder = new TextEncoder()
    const openBuildEvents = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(line({ type: 'build', build: buildView() })))
            // An old Worker: no heartbeat, then output after two idle windows.
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  line({ type: 'log', stream: 'stdout', data: 'done installing\n' }) +
                    line({ type: 'build', build: buildView({ status: 'succeeded' }) }) +
                    line({ type: 'end' })
                )
              )
              controller.close()
            }, 70)
          }
        })
    )
    await watchHostedEnvironmentBuild({
      client: { openBuildEvents, getBuild },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => events.push(event),
      idleTimeoutMs: 30,
      sleep: noSleep
    }).done
    expect(summarize(events)).toEqual([
      'build:running',
      'log:stdout:done installing\n',
      'build:succeeded',
      'end'
    ])
    expect(openBuildEvents).toHaveBeenCalledTimes(1)
    expect(getBuild).toHaveBeenCalled()
  })

  it('never gives up on a quiet build the API keeps vouching for', async () => {
    const events: OrcaCloudEnvironmentBuildStreamEvent[] = []
    let opens = 0
    const openBuildEvents = vi.fn(async (_env: string, _build: string, signal: AbortSignal) =>
      // Every pass replays the same status and no new bytes, then goes silent.
      ++opens <= 6
        ? ndjsonBody([line({ type: 'build', build: buildView() })], { hang: true, signal })
        : ndjsonBody([
            line({ type: 'build', build: buildView({ status: 'succeeded' }) }),
            line({ type: 'end' })
          ])
    )
    await watchHostedEnvironmentBuild({
      client: { openBuildEvents, getBuild: async () => buildView() },
      envId: ENV_ID,
      buildId: BUILD_ID,
      onEvent: (event) => events.push(event),
      idleTimeoutMs: 5,
      maxQuietProbes: 1,
      maxStalledReconnects: 2,
      sleep: noSleep
    }).done
    expect(openBuildEvents).toHaveBeenCalledTimes(7)
    expect(events.at(-1)).toEqual({ type: 'end' })
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })
})
