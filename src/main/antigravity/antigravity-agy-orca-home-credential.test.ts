import { expect, it } from 'vitest'
import { agyOrcaHomeKeyPresent, envHasGeminiApiKey } from './antigravity-agy-orca-home-credential'

const none = async () => false

it('routes with a key in GEMINI_API_KEY or a saved key', async () => {
  expect(await agyOrcaHomeKeyPresent({ GEMINI_API_KEY: 'k' }, none)).toBe(true)
  expect(await agyOrcaHomeKeyPresent({}, async () => true)).toBe(true)
})

it('finds none when the variable is blank and no key is saved', async () => {
  expect(await agyOrcaHomeKeyPresent({ GEMINI_API_KEY: ' ' }, none)).toBe(false)
  expect(await agyOrcaHomeKeyPresent({}, none)).toBe(false)
})

it('reads a launch env by its own GEMINI_API_KEY only', () => {
  expect(envHasGeminiApiKey({ GEMINI_API_KEY: 'k' })).toBe(true)
  expect(envHasGeminiApiKey({ GEMINI_API_KEY: '' })).toBe(false)
  expect(envHasGeminiApiKey({})).toBe(false)
})
