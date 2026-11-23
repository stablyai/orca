import { expect, it } from 'vitest'
import { agyOrcaHomeKeyPresent } from './antigravity-agy-orca-home-credential'

const none = async () => null

it('finds a key in GEMINI_API_KEY or a saved key that decrypts', async () => {
  expect(await agyOrcaHomeKeyPresent({ GEMINI_API_KEY: 'k' }, none)).toBe(true)
  expect(await agyOrcaHomeKeyPresent({}, async () => 'saved')).toBe(true)
})

it('finds none when the variable is blank and no saved key decrypts', async () => {
  expect(await agyOrcaHomeKeyPresent({ GEMINI_API_KEY: ' ' }, none)).toBe(false)
  expect(await agyOrcaHomeKeyPresent({}, none)).toBe(false)
})
