import { describe, expect, it } from 'vitest'
import { codexItemBody, codexStreamingJournalItem } from './codex-structured-item-translation'
import { boundStreamItem } from './codex-structured-item-stream-bounds'

const command = {
  type: 'commandExecution',
  id: 'cmd',
  command: 'missing-command',
  status: 'completed'
}

describe('command row metadata', () => {
  it.each([0, 127, -1])('preserves exit %s with provider duration', (exitCode) => {
    expect(codexItemBody({ ...command, exitCode, durationMs: 400 })).toMatchObject({
      kind: 'tool-call',
      name: 'shell',
      exitCode,
      durationMs: 400,
      state: exitCode === 0 ? 'completed' : 'failed'
    })
  })
  it('omits unavailable or invalid values', () => {
    for (const fields of [
      {},
      { exitCode: null, durationMs: null },
      { exitCode: 1.5, durationMs: -1 }
    ]) {
      const body = codexItemBody({ ...command, ...fields })
      expect(body).not.toHaveProperty('exitCode')
      expect(body).not.toHaveProperty('durationMs')
    }
  })
  it('keeps snake-case duration through streamed and oversized command snapshots', () => {
    const source = {
      ...command,
      exitCode: 0,
      duration_ms: 400,
      aggregatedOutput: 'x'.repeat(70000)
    }
    expect(boundStreamItem(source)).toMatchObject({ exitCode: 0, durationMs: 400 })
    expect(codexStreamingJournalItem(source, 'output').body).toMatchObject({
      exitCode: 0,
      durationMs: 400
    })
  })
  it('keeps metadata on classified exec rows', () => {
    expect(
      codexItemBody({
        ...command,
        exitCode: 0,
        durationMs: 15,
        commandActions: [{ type: 'read', command: 'cat a.ts', name: 'a.ts', path: 'a.ts' }]
      })
    ).toMatchObject({ name: 'read', exitCode: 0, durationMs: 15 })
  })
})

describe('web result annotations', () => {
  it('adds safe result annotations and retains old-reader JSON output', () => {
    const results = [{ title: 'Docs', url: 'https://example.com/' }, { url: 'javascript:alert(1)' }]
    const body = codexItemBody({
      type: 'webSearch',
      id: 'web',
      query: 'docs',
      action: { type: 'search' },
      results
    })
    expect(body).toMatchObject({
      kind: 'tool-call',
      name: 'web_search',
      state: 'completed',
      webSearchResults: [results[0]],
      output: { head: JSON.stringify(results) }
    })
  })
  it('leaves legacy and malformed results without an annotation', () => {
    expect(
      codexItemBody({ type: 'webSearch', id: 'web', query: 'docs', results: [{}] })
    ).not.toHaveProperty('webSearchResults')
  })
})

it('annotates only confirmed MCP calls and retains the raw server/tool name', () => {
  expect(
    codexItemBody({ type: 'mcpToolCall', id: 'm', server: 'my_server', tool: 'ns.tool' })
  ).toMatchObject({
    kind: 'tool-call',
    name: 'my_server/ns.tool',
    mcpIdentity: { server: 'my_server', tool: 'ns.tool' }
  })
  expect(codexItemBody(command)).not.toHaveProperty('mcpIdentity')
})
