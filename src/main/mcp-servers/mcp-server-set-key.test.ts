import { describe, expect, it } from 'vitest'
import { mcpServerSetKey } from './mcp-server-set-key'

const secret = (byte: number) => Promise.resolve(Buffer.alloc(32, byte))
const stdio = {
  name: 'clock',
  command: 'node',
  args: ['clock.mjs'],
  env: [{ name: 'PIN', value: '1234' }]
}
const http = { name: 'docs', type: 'http', url: 'http://127.0.0.1:8080/mcp', headers: [] }

describe('mcpServerSetKey', () => {
  it('is order-free, changes with any server field, and depends on the install secret', async () => {
    const key = await mcpServerSetKey([stdio, http], secret(1))
    expect(await mcpServerSetKey([http, stdio], secret(1))).toBe(key)
    expect(
      await mcpServerSetKey([{ ...stdio, env: [{ name: 'PIN', value: '1235' }] }, http], secret(1))
    ).not.toBe(key)
    expect(await mcpServerSetKey([stdio, { ...http, type: 'sse' }], secret(1))).not.toBe(key)
    // Under another install's secret the same set gives another key: a stored key can't be checked against guesses.
    expect(await mcpServerSetKey([stdio, http], secret(2))).not.toBe(key)
  })
})
