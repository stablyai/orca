import { expect, it } from 'vitest'
import { isOrcaAttributedPrompt } from './macos-tcc-prompt-watch'

it("attributes an app profile's prompt to Orca, but not a lookalike bundle id", () => {
  const prompt = (responsibleIdentifier: string): boolean =>
    isOrcaAttributedPrompt({
      service: 'kTCCServiceSystemPolicyAllFiles',
      accessingIdentifier: 'x',
      responsibleIdentifier
    })
  expect(prompt('com.stablyai.orca.profile.work')).toBe(true)
  expect(prompt('com.stablyai.orcax')).toBe(false)
  expect(prompt('com.stablyai.orca.profilex')).toBe(false)
})
