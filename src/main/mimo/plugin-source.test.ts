import { describe, expect, it } from 'vitest'
import { getMimoPluginSource } from './plugin-source'

describe('Mimo hook plugin source', () => {
  it('contains the /hook/mimo route', () => {
    const source = getMimoPluginSource()
    expect(source).toContain('/hook/mimo')
  })

  it('filters child sessions via parentID lookup before forwarding events', () => {
    const source = getMimoPluginSource()

    expect(source).toContain('async function isChildSession(client, sessionID)')
    expect(source).toContain('const sessions = await client.session.list();')
    expect(source).toContain('const isChild = !!session?.parentID;')
    expect(source).toContain('if (sessionID && (await isChildSession(client, sessionID))) {')
    expect(source).toContain('return true;')
  })

  it('still accepts an optional opaque plugin context instead of destructuring', () => {
    const source = getMimoPluginSource()

    expect(source).toContain('export const OrcaMimoStatusPlugin = async (_ctx) => {')
    expect(source).toContain('const client = _ctx?.client;')
  })

  it('resolves hook coords from the endpoint file before falling back to process.env', () => {
    const source = getMimoPluginSource()

    expect(source).toContain('function readEndpointFile()')
    expect(source).toContain('process.env.ORCA_AGENT_HOOK_ENDPOINT')
    expect(source).toContain('/^(?:set\\s+)?([A-Z0-9_]+)=(.*)$/')
    expect(source).toContain('function resolveHookCoords()')
    expect(source).toContain(
      'port: fileEnv.ORCA_AGENT_HOOK_PORT || process.env.ORCA_AGENT_HOOK_PORT'
    )
    expect(source).toContain(
      'token: fileEnv.ORCA_AGENT_HOOK_TOKEN || process.env.ORCA_AGENT_HOOK_TOKEN'
    )
    expect(source).toContain('const coords = resolveHookCoords();')
    expect(source).toContain('`http://127.0.0.1:${coords.port}/hook/mimo`')
    expect(source).toContain('"X-Orca-Agent-Hook-Token": coords.token')
  })

  it('forwards question.asked as AskUserQuestion so the pane flips to waiting', () => {
    const source = getMimoPluginSource()

    expect(source).toContain('if (event.type === "question.asked")')
    expect(source).toContain('await post("AskUserQuestion", event.properties || {});')
  })
})
