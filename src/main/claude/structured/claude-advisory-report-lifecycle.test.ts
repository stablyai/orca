import { expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { createClaudeAdvisoryControls } from './claude-advisory-controls'

it.each([false, true])(
  'revokes snapshot access and stops the owned connection after a report (ambiguous=%s)',
  async (ambiguous) => {
    const published: unknown[] = []
    const controls = createClaudeAdvisoryControls(
      {
        schema: 1,
        dataScope: 'published',
        sourcePin: 'a'.repeat(40),
        deadlineAt: Date.now() + 30_000,
        maxModelCalls: 4,
        artifacts: [
          {
            path: 'note.txt',
            text: 'hello',
            sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
          }
        ]
      },
      sdk,
      {},
      async (report) => {
        published.push(report)
        if (ambiguous) {
          throw new Error('private backend detail')
        }
      }
    )
    let stopped: unknown
    controls.bindClose(async (options) => {
      stopped = options
      return false
    })
    const config = controls.options.mcpServers?.orca_advisor
    if (!config || config.type !== 'sdk') {
      throw new Error('Missing advisory server.')
    }
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'advisory-report-lifecycle', version: '1' })
    try {
      await config.instance.connect(serverTransport)
      await client.connect(clientTransport)
      const response = await client.callTool({
        name: 'report_advice',
        arguments: { status: 'inconclusive' }
      })
      expect(published).toEqual([{ status: 'inconclusive' }])
      expect(stopped).toEqual({ grace: 'brief' })
      expect(controls.admitInput()?.message).toContain('Advisor access ended.')
      const read = await client.callTool({ name: 'read_artifact', arguments: { path: 'note.txt' } })
      expect(read.isError).toBe(true)
      if (ambiguous) {
        expect(response.isError).toBe(true)
      } else {
        expect(response.structuredContent).toEqual({ state: 'submitted' })
      }
    } finally {
      controls.end()
      await client.close()
      await config.instance.close()
    }
  }
)
