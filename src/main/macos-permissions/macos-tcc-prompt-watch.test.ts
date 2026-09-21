import { describe, expect, it } from 'vitest'
import { isOwnAttributedPrompt } from './macos-tcc-prompt-watch'

describe('isOwnAttributedPrompt', () => {
  it('accepts the running bundle and its detached terminal helper, whatever it is named', () => {
    for (const own of ['com.stablyai.orca', 'com.stablyai.orca.dev', 'com.example.fork']) {
      for (const id of [own, `${own}.helper`]) {
        expect(
          isOwnAttributedPrompt(
            {
              service: 'kTCCServiceSystemPolicyAppData',
              accessingIdentifier: 'find',
              responsibleIdentifier: id
            },
            own
          )
        ).toBe(true)
      }
    }
  })

  it('rejects another app that happens to share a prefix, and an unidentifiable bundle', () => {
    const event = {
      service: 'kTCCServiceSystemPolicyAppData',
      accessingIdentifier: 'find',
      responsibleIdentifier: 'com.stablyai.orcafake'
    }
    expect(isOwnAttributedPrompt(event, 'com.stablyai.orca')).toBe(false)
    expect(
      isOwnAttributedPrompt({ ...event, responsibleIdentifier: 'com.stablyai.orca' }, null)
    ).toBe(false)
  })

  it('rejects dialogs another app is responsible for', () => {
    expect(
      isOwnAttributedPrompt(
        {
          service: 'kTCCServiceSystemPolicyAppData',
          accessingIdentifier: 'find',
          responsibleIdentifier: 'com.apple.Terminal'
        },
        'com.stablyai.orca'
      )
    ).toBe(false)
  })
})
