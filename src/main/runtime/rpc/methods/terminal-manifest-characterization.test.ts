import { describe, expect, it } from 'vitest'
import { TERMINAL_METHODS } from './terminal'
import { eraseRpcMethods } from '../core'

function schemaFor(name: string) {
  const method = eraseRpcMethods(TERMINAL_METHODS).find((candidate) => candidate.name === name)
  if (!method?.params) {
    throw new Error(`Missing terminal schema: ${name}`)
  }
  return method.params
}
describe('terminal RPC manifest characterization', () => {
  it('keeps legacy coercion and viewport-boundary differences', () => {
    expect(schemaFor('terminal.list').parse({ limit: 'invalid' })).toEqual({})
    expect(schemaFor('terminal.split').parse({ terminal: 'term', direction: 'diagonal' })).toEqual({
      terminal: 'term'
    })
    expect(() => schemaFor('terminal.rename').parse({ terminal: 'term' })).toThrow()
    expect(schemaFor('terminal.rename').parse({ terminal: 'term', title: '' })).toEqual({
      terminal: 'term',
      title: ''
    })
    expect(() =>
      schemaFor('terminal.updateViewport').parse({
        terminal: 'term',
        client: { id: 'client' },
        viewport: { cols: 1025, rows: 120 }
      })
    ).toThrow()
    expect(() =>
      schemaFor('terminal.updateViewport').parse({
        terminal: 'term',
        client: { id: 'client' },
        viewport: { cols: 1024, rows: 500 }
      })
    ).not.toThrow()
    expect(() =>
      schemaFor('terminal.subscribe').parse({
        terminal: 'term',
        viewport: { cols: 1000, rows: 500 }
      })
    ).not.toThrow()
    expect(() =>
      schemaFor('terminal.setDisplayMode').parse({
        terminal: 'term',
        mode: 'auto',
        viewport: { cols: 1001, rows: 501 }
      })
    ).not.toThrow()
  })
})
