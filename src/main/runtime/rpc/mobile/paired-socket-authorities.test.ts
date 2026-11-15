import { expect, it } from 'vitest'
import { pairedAuthorityReply } from './paired-socket-authorities'

it('fences unsent replies after observed revocation and preserves the authorized handoff boundary', () => {
  const controller = new AbortController()
  const delivered: string[] = []
  const reply = pairedAuthorityReply((response) => delivered.push(response), {
    id: 'paired-incarnation',
    signal: controller.signal
  })
  reply('already handed to transport')
  controller.abort()
  reply('pending when authority was revoked')
  expect(delivered).toEqual(['already handed to transport'])
})
