import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { parseConnectorRef } from './action-messages.js'

// The machine's slack-thread-link-ref.test.ts builds these refs from a thread's link, for a bot to
// post there; each must read as that very thread.
const Thread = z.object({ ref: z.string(), workspaceId: z.string(), containerId: z.string(), threadId: z.string() })
const corpus = z
  .object({ threads: z.array(Thread).min(1) })
  .parse(JSON.parse(readFileSync(new URL('./test-fixtures/slack-thread-link-refs.json', import.meta.url), 'utf8')))

it('reads each ref a machine builds from a Slack thread link as that thread', () => {
  for (const { ref, workspaceId, containerId, threadId } of corpus.threads) {
    expect(parseConnectorRef(ref)).toEqual({ source: 'slack', workspaceId, containerId, threadId })
  }
})
