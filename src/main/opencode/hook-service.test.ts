import { describe, expect, it } from 'vitest'
import { _internals } from './hook-service'

describe('OpenCode hook plugin source', () => {
  it('filters child sessions via parentID lookup before forwarding events', () => {
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('async function isChildSession(client, sessionID)')
    expect(source).toContain('const sessions = await client.session.list();')
    expect(source).toContain('const isChild = !!session?.parentID;')
    expect(source).toContain('if (sessionID && (await isChildSession(client, sessionID))) {')
    expect(source).toContain('return true;')
  })

  it('still accepts an optional opaque plugin context instead of destructuring', () => {
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('export const OrcaOpenCodeStatusPlugin = async (_ctx) => {')
    expect(source).toContain('const client = _ctx?.client;')
  })
})
