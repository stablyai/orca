// Live ACP handshake against a real agent. Opt-in: these spawn `hermes acp` /
// `omp acp`, so they only run where those are installed.
//
//   ORCA_ACP_LIVE=1 npx vitest run --config config/vitest.config.ts \
//     src/main/acp/acp-stdio-client.live.test.ts
//
// Why keep them in-tree rather than as a scratch script: the unit tests use a
// fake child process, so they prove correlation and teardown but not the
// protocol assumptions (ndjson framing, capability field names, session/new
// shape). This file is the receipt that those assumptions hold against the
// shipped agents.

import { describe, expect, it } from 'vitest'
import { createAcpStdioClient } from './acp-stdio-client'
import { createAcpTurnAccumulator } from '../native-chat/acp-event-mapper'

const LIVE = process.env.ORCA_ACP_LIVE === '1'

describe.skipIf(!LIVE)('live ACP handshake', () => {
  it(
    'initializes hermes acp and reports session capabilities',
    async () => {
      const logs: string[] = []
      const client = createAcpStdioClient({
        command: 'hermes',
        args: ['acp'],
        cwd: process.cwd(),
        onSessionUpdate: () => {},
        onLog: (line) => logs.push(line)
      })
      try {
        const result = await client.initialize()
        expect(result.protocolVersion).toBe(1)
        expect(result.agentInfo?.name).toBe('hermes-agent')
        // loadSession + session resume are what let the chat view reopen history.
        expect(result.agentCapabilities?.loadSession).toBe(true)
      } finally {
        client.dispose()
      }
    },
    180_000
  )

  it(
    'initializes omp acp',
    async () => {
      const client = createAcpStdioClient({
        command: 'omp',
        args: ['acp'],
        cwd: process.cwd(),
        onSessionUpdate: () => {}
      })
      try {
        const result = await client.initialize()
        expect(result.protocolVersion).toBe(1)
        expect(result.agentCapabilities?.loadSession).toBe(true)
      } finally {
        client.dispose()
      }
    },
    180_000
  )

  it(
    'opens a session and streams a reply through the mapper',
    async () => {
      const messages: string[] = []
      let sessionId = 'pending'
      const accumulator = createAcpTurnAccumulator('live')
      const client = createAcpStdioClient({
        command: 'hermes',
        args: ['acp'],
        cwd: process.cwd(),
        onSessionUpdate: (update) => {
          const decoded = accumulator.decode(update)
          for (const message of decoded.messages) {
            const text = message.blocks
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join('')
            if (text.length > 0) {
              messages.push(`${message.role}:${text}`)
            }
          }
        }
      })
      try {
        await client.initialize()
        sessionId = await client.newSession({ cwd: process.cwd() })
        expect(sessionId).toBeTruthy()

        await client.prompt(sessionId, [
          { type: 'text', text: 'Reply with exactly the word ORCA and nothing else.' }
        ])

        // At least one assistant/reasoning message must have streamed through.
        expect(messages.length).toBeGreaterThan(0)
      } finally {
        client.dispose()
      }
    },
    300_000
  )
})
