import { describe, expect, it } from 'vitest'
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

    // Why: a non-zero parameter is a secondary/tertiary DA request, not DA1.
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
    // Why pinned: the renderer's xterm answers `?1;2c` for xterm-* TERMs. Diverging here
    // would silently change the capabilities a TUI sees on barrier-gated panes only.
    expect(STARTUP_DA1_RESPONSE).toBe('\x1b[?1;2c')
  })
})

describe('startup device attributes query filter', () => {
  it('removes both DA1 forms while preserving surrounding output', () => {
    const filter = new StartupDeviceAttributesQueryFilter()

    expect(filter.accept(`before\x1b[c middle\x1b[0c after`)).toBe('before middle after')
  })

  it('removes a DA1 query split at every chunk boundary', () => {
    for (const query of ['\x1b[c', '\x1b[0c']) {
      for (let split = 1; split < query.length; split++) {
        const filter = new StartupDeviceAttributesQueryFilter()
        expect(filter.accept(`before${query.slice(0, split)}`)).toBe('before')
        expect(filter.accept(`${query.slice(split)}after`)).toBe('after')
        expect(filter.release()).toBe('')
      }
    }
  })

  it('releases incomplete and non-DA1 sequences unchanged', () => {
    const filter = new StartupDeviceAttributesQueryFilter()

    expect(filter.accept('before\x1b[')).toBe('before')
    expect(filter.release()).toBe('\x1b[')
    expect(filter.accept('\x1b[>c')).toBe('\x1b[>c')
  })
})
