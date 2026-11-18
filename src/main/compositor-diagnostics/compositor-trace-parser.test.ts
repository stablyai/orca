import { describe, expect, it } from 'vitest'
import { createCompositorTraceParser } from './compositor-trace-parser'

describe('compositor diagnostic evidence', () => {
  it('keeps attempts and aborted calculations distinct from presentation and sorter progress', () => {
    const parser = createCompositorTraceParser([41])
    parser.write(
      Buffer.from(
        JSON.stringify({
          traceEvents: [
            { pid: 41, tid: 7, ph: 'M', name: 'thread_name', args: { name: 'Compositor' } },
            {
              pid: 41,
              tid: 7,
              ph: 'X',
              name: 'LayerTreeHostImpl::CalculateRenderPasses',
              args: { draw_result: 2 }
            },
            {
              pid: 41,
              tid: 7,
              ph: 'X',
              name: 'LayerTreeHostImpl::CalculateRenderPasses',
              args: { draw_result: 1 }
            },
            {
              pid: 41,
              tid: 7,
              ph: 'X',
              name: 'LayerTreeHostImpl::CalculateRenderPasses',
              args: {}
            },
            {
              pid: 41,
              tid: 7,
              ph: 'X',
              name: 'cc::Scheduler::FinishImplFrame',
              dur: 6000,
              tdur: 4000
            }
          ]
        })
      )
    )
    const result = parser.finish()
    expect(result).toMatchObject({
      ok: true,
      observations: [
        {
          pid: 41,
          classification: 'observations-only',
          renderPassAttempts: 3,
          calculationSuccesses: 1,
          calculationAborts: 1,
          calculationUnknown: 1,
          frameProxyBegins: 0,
          finishImplFrameWallMs: 6,
          finishImplFrameThreadMs: 4,
          submissions: null,
          presentations: null,
          sorterProgress: null,
          surfaceIdentity: null,
          trackerCoverage: 'unknown'
        }
      ]
    })
  })

  it('reports sparse process-level proxy progress without exonerating a surface or unrelated renderer', () => {
    const parser = createCompositorTraceParser([41, 42])
    const text = JSON.stringify({
      traceEvents: [
        { pid: 41, tid: 7, ph: 'b', cat: 'cc,benchmark', name: 'Frame   ' },
        { pid: 41, tid: 7, ph: 'e', cat: 'cc,benchmark', name: 'Frame   ' },
        { pid: 99, tid: 8, ph: 'b', cat: 'cc,benchmark', name: 'Frame' }
      ]
    })
    for (let offset = 0; offset < text.length; offset += 13) {
      parser.write(Buffer.from(text.slice(offset, offset + 13)))
    }
    expect(parser.finish()).toMatchObject({
      ok: true,
      observations: [
        {
          pid: 41,
          classification: 'proxy-progress-observed',
          frameProxyBegins: 1,
          frameProxyEnds: 1,
          exactFrameProxyEvents: 0,
          surfaceIdentity: null,
          sorterProgress: null
        },
        {
          pid: 42,
          classification: 'observations-only',
          frameProxyBegins: 0,
          finishImplFrameThreadMs: null,
          sorterProgress: null
        }
      ]
    })
  })

  it.each([
    { metadata: [] },
    { metadata: [{ pid: 41, tid: 7, ph: 'M', name: 'thread_name', args: {} }] }
  ])(
    'keeps compositor totals unknown when thread metadata is absent or filtered: %j',
    ({ metadata }) => {
      const parser = createCompositorTraceParser([41])
      parser.write(
        Buffer.from(
          JSON.stringify({
            traceEvents: [
              ...metadata,
              {
                pid: 41,
                tid: 7,
                ph: 'X',
                name: 'cc::Scheduler::FinishImplFrame',
                dur: 6000,
                tdur: 4000
              }
            ]
          })
        )
      )
      expect(parser.finish()).toMatchObject({
        ok: true,
        observations: [
          {
            compositorThreadCoverage: 'unidentified',
            finishImplFrameSlices: null,
            finishImplFrameWallMs: null,
            finishImplFrameThreadMs: null
          }
        ]
      })
    }
  )

  it('distinguishes an identified compositor with no matching slices from unknown coverage', () => {
    const parser = createCompositorTraceParser([41])
    parser.write(
      Buffer.from(
        JSON.stringify({
          traceEvents: [
            { pid: 41, tid: 7, ph: 'M', name: 'thread_name', args: { name: 'Compositor' } }
          ]
        })
      )
    )
    expect(parser.finish()).toMatchObject({
      ok: true,
      observations: [
        {
          compositorThreadCoverage: 'identified',
          finishImplFrameSlices: 0,
          finishImplFrameWallMs: 0,
          finishImplFrameThreadMs: 0,
          sorterProgress: null
        }
      ]
    })
  })

  it('refuses a partial recording instead of reporting its prefix as a valid observation', () => {
    const parser = createCompositorTraceParser([41])
    parser.write(
      Buffer.from('{"traceEvents":[{"pid":41,"tid":7,"ph":"b","cat":"cc,benchmark","name":"Frame"}')
    )
    expect(() => parser.finish()).toThrow(SyntaxError)
  })
})
