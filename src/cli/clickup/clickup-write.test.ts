import { expect, it } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { CLICKUP_WRITE_HANDLERS } from './clickup-write'

it('tells an agent to verify a comment whose reply frame was malformed', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the write handler only calls client.call.
  const client = {
    call: async (method: string) => {
      if (method === 'clickup.status') {
        return { result: { connected: true } }
      }
      throw new RuntimeClientError('invalid_runtime_response', 'Runtime sent an invalid reply.')
    }
  } as unknown as RuntimeClient
  const context: HandlerContext = {
    flags: new Map<string, string | boolean>([
      ['id', '86abc12de'],
      ['body', 'Done']
    ]),
    client,
    cwd: process.cwd(),
    json: false
  }

  await expect(CLICKUP_WRITE_HANDLERS['clickup comment add'](context)).rejects.toMatchObject({
    code: 'clickup_write_unverified'
  })
})
