import type { PtyIngressEmission } from '../../shared/pty-startup-ingress'
import { describe, expect, it, vi } from 'vitest'
import {
  installDeviceAttributesResponder,
  STARTUP_DA1_RESPONSE,
  StartupDeviceAttributesQueryFilter
} from './startup-device-attributes-responder'

type CsiHandler = (params: number[]) => boolean

function createFakeParser() {
  const handlers: CsiHandler[] = []
  return {
    registered: handlers,
    parser: {
      registerCsiHandler(_id: { final: string }, handler: CsiHandler) {
        handlers.push(handler)
        return {
          dispose() {
            const at = handlers.indexOf(handler)
            if (at !== -1) {
              handlers.splice(at, 1)
            }
          }
        }
      }
    } as never
  }
}

describe('startup device attributes responder', () => {
  it('answers a bare DA1 query and consumes it so the renderer cannot double-reply', () => {
    const { parser, registered } = createFakeParser()
    const replies: string[] = []

    installDeviceAttributesResponder({
      parser,
      response: STARTUP_DA1_RESPONSE,
      reply: (d) => replies.push(d)
    })

    expect(registered[0]?.([])).toBe(true)
    expect(replies).toEqual([STARTUP_DA1_RESPONSE])
  })

  it('answers the explicit `CSI 0 c` form', () => {
    const { parser, registered } = createFakeParser()
    const replies: string[] = []

    installDeviceAttributesResponder({
      parser,
      response: STARTUP_DA1_RESPONSE,
      reply: (d) => replies.push(d)
    })

    expect(registered[0]?.([0])).toBe(true)
    expect(replies).toEqual([STARTUP_DA1_RESPONSE])
  })

  it('answers every occurrence, because shells re-query around each prompt', () => {
    const { parser, registered } = createFakeParser()
    const replies: string[] = []

    installDeviceAttributesResponder({
      parser,
      response: STARTUP_DA1_RESPONSE,
      reply: (d) => replies.push(d)
    })

    registered[0]?.([])
    registered[0]?.([])

    expect(replies).toEqual([STARTUP_DA1_RESPONSE, STARTUP_DA1_RESPONSE])
  })

  it('declines non-primary variants so they fall through to the renderer', () => {
    const { parser, registered } = createFakeParser()
    const replies: string[] = []

    installDeviceAttributesResponder({
      parser,
      response: STARTUP_DA1_RESPONSE,
      reply: (d) => replies.push(d)
    })

    // Nonzero or extra parameters are unsupported here; they do not identify secondary DA requests.
    expect(registered[0]?.([1])).toBe(false)
    expect(registered[0]?.([0, 1])).toBe(false)
    expect(replies).toEqual([])
  })

  it('stops answering once disposed, handing the query back to the renderer', () => {
    const { parser, registered } = createFakeParser()
    const replies: string[] = []

    const release = installDeviceAttributesResponder({
      parser,
      response: STARTUP_DA1_RESPONSE,
      reply: (d) => replies.push(d)
    })
    release()

    expect(registered).toHaveLength(0)
    expect(replies).toEqual([])
  })

  it('reports the same primary attributes the renderer would, so consuming the query is transparent', () => {
    expect(STARTUP_DA1_RESPONSE).toBe('\x1b[?1;2c')
  })
})

function createQueryFilterHarness() {
  const filter = new StartupDeviceAttributesQueryFilter()
  let accepted = 0
  let emitted = 0
  const text = (spans: PtyIngressEmission[]): string => {
    for (const span of spans) {
      expect(span.rawStartSeq).toBe(emitted)
      expect(span.rawEndSeq).toBeGreaterThanOrEqual(span.rawStartSeq)
      expect(span.rawEndSeq).toBeLessThanOrEqual(accepted)
      if (span.transformed) {
        expect(span.data).toBe('')
        expect(span.rawEndSeq).toBeGreaterThan(span.rawStartSeq)
      } else {
        expect(span.rawEndSeq - span.rawStartSeq).toBe(span.data.length)
      }
      emitted = span.rawEndSeq
    }
    return spans.map((span) => span.data).join('')
  }
  return {
    accept(data: string): string {
      const rawStartSeq = accepted
      accepted += data.length
      return text(
        filter.acceptEmission({ data, rawStartSeq, rawEndSeq: accepted, transformed: false })
      )
    },
    release(): string {
      const pending = filter.releaseEmission()
      const output = text(pending ? [pending] : [])
      expect(emitted).toBe(accepted)
      return output
    }
  }
}

describe('startup device attributes query filter', () => {
  it('removes both DA1 forms while preserving surrounding output', () => {
    const filter = createQueryFilterHarness()

    expect(filter.accept(`before\x1b[c middle\x1b[0c after`)).toBe('before middle after')
    expect(filter.release()).toBe('')
  })

  it('removes a DA1 query split at every chunk boundary', () => {
    for (const query of ['\x1b[c', '\x1b[0c']) {
      for (let split = 1; split < query.length; split++) {
        const filter = createQueryFilterHarness()
        expect(filter.accept(`before${query.slice(0, split)}`)).toBe('before')
        expect(filter.accept(`${query.slice(split)}after`)).toBe('after')
        expect(filter.release()).toBe('')
      }
    }
  })

  it('releases incomplete and non-DA1 sequences unchanged', () => {
    const filter = createQueryFilterHarness()

    expect(filter.accept('before\x1b[')).toBe('before')
    expect(filter.release()).toBe('\x1b[')
    expect(filter.accept('\x1b[>c')).toBe('\x1b[>c')
    expect(filter.release()).toBe('')
  })
})

it('retains source spans across a torn DA1 query without joining receipt fragments', async () => {
  const { createSetupCompletionObservation } =
    await import('../runtime/orchestration/setup-completion-signal')
  const filter = new StartupDeviceAttributesQueryFilter()
  const observed = createSetupCompletionObservation('native:filter', true)
  const receipt = 'ORCA_SETUP_DONE:native:filter:0;'
  const complete = vi.fn()
  void observed.completion.then(complete)
  let end = 0
  for (const data of [`${receipt.slice(0, 10)}\x1b[`, `0c${receipt.slice(10)}`, receipt]) {
    const rawStartSeq = end
    end += data.length
    for (const span of filter.acceptEmission({
      data,
      rawStartSeq,
      rawEndSeq: end,
      transformed: false
    })) {
      observed.scan(span.data, span.rawEndSeq - span.rawStartSeq, span.transformed, span.rawEndSeq)
    }
    observed.publish()
    await Promise.resolve()
    if (data !== receipt) {
      expect(complete).not.toHaveBeenCalled()
    }
  }
  expect(observed.unknown).toBe(false)
  await expect(observed.completion).resolves.toEqual({ exitCode: 0 })
})
