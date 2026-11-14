import { describe, expect, it } from 'vitest'
import { parseCodexDeviceAuthPrompt } from './codex-device-auth-prompt'

// Captured from `codex login --device-auth` (codex-cli 0.163.0) with piped stdout; code replaced.
const TRANSCRIPT =
  "\nWelcome to Codex [v\u001b[90m0.163.0\u001b[0m]\n\u001b[90mOpenAI's command-line coding agent\u001b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mABCD-EFGH1\u001b[0m\n\n\u001b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u001b[0m\n"

describe('parseCodexDeviceAuthPrompt', () => {
  it('reads the device page and one-time code from the captured transcript', () => {
    expect(parseCodexDeviceAuthPrompt(TRANSCRIPT)).toEqual({
      url: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH1'
    })
  })

  it('waits until the code is complete', () => {
    const codeAt = TRANSCRIPT.indexOf('ABCD')
    expect(parseCodexDeviceAuthPrompt(TRANSCRIPT.slice(0, codeAt + 6))).toBeNull()
    expect(parseCodexDeviceAuthPrompt(TRANSCRIPT.slice(0, codeAt - 10))).toBeNull()
  })

  it('offers no page but OpenAI’s own', () => {
    const spoofed = TRANSCRIPT.replace('https://auth.openai.com/codex/device', 'https://evil.test/')
    expect(parseCodexDeviceAuthPrompt(spoofed)).toBeNull()
  })
})
