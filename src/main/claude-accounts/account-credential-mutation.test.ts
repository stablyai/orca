import { expect, it } from 'vitest'
import { withClaudeAccountCredentialMutation } from './account-credential-mutation'

it('serializes refresh and enrollment for the same account while other accounts can proceed', async () => {
  const events: string[] = []
  let release = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const refresh = withClaudeAccountCredentialMutation('a', async () => {
    events.push('refresh')
    await blocked
    events.push('refreshed')
  })
  const enrollment = withClaudeAccountCredentialMutation('a', async () => {
    events.push('enroll')
  })
  await withClaudeAccountCredentialMutation('b', async () => {
    events.push('other')
  })
  expect(events).toEqual(['refresh', 'other'])
  release()
  await Promise.all([refresh, enrollment])
  expect(events).toEqual(['refresh', 'other', 'refreshed', 'enroll'])
})

it('releases account mutation authority after a failure', async () => {
  await expect(
    withClaudeAccountCredentialMutation('a', async () => {
      throw new Error('failed')
    })
  ).rejects.toThrow('failed')
  await expect(withClaudeAccountCredentialMutation('a', async () => 'recovered')).resolves.toBe(
    'recovered'
  )
})
