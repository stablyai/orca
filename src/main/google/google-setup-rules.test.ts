import { describe, expect, it } from 'vitest'
import { GoogleSetupRunSchema } from '../../shared/google/google-setup-run'
import { recordAnswer } from './google-setup-rules'

const run = () =>
  GoogleSetupRunSchema.parse({
    id: 'run-1',
    botId: 'bot-1',
    state: 'running',
    mode: 'guide-here',
    steps: {},
    startedAt: 0,
    updatedAt: 0,
    revision: 0
  })

describe('the services answer and read-draft access', () => {
  it('lets a bot narrow the owner’s pick but never widen it', () => {
    const answered = run()
    recordAnswer(answered, 'owner', 'services', ['gmail', 'read-draft'], 1)
    expect(answered.access).toBe('read-draft')

    recordAnswer(answered, 'bot', 'services', ['gmail', 'calendar'], 2)
    expect(answered.access).toBe('read-draft')
    expect(answered.services).toEqual(['gmail', 'calendar'])

    recordAnswer(answered, 'owner', 'services', ['gmail'], 3)
    expect(answered.access).toBeUndefined()

    recordAnswer(answered, 'bot', 'services', ['gmail', 'read-draft'], 4)
    expect(answered.access).toBe('read-draft')
  })
})
