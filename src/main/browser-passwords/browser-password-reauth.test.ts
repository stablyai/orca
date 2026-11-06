import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { canPromptTouchID, promptTouchID, runProcess } = vi.hoisted(() => ({
  canPromptTouchID: vi.fn(() => false),
  promptTouchID: vi.fn(async () => {}),
  runProcess: vi.fn()
}))
vi.mock('electron', () => ({ systemPreferences: { canPromptTouchID, promptTouchID } }))
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('./browser-password-vault-access', () => ({ browserPasswordSettings: vi.fn() }))

import {
  confirmBrowserPasswordOwner,
  resetBrowserPasswordReauthForTests
} from './browser-password-reauth'

const originalPlatform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  resetBrowserPasswordReauthForTests()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

it.each([
  { templates: '2 biometric template(s)', confirmed: false },
  { templates: '0 biometric template(s)', confirmed: true }
])(
  'when Touch ID cannot prompt, $templates confirms: $confirmed',
  async ({ templates, confirmed }) => {
    runProcess.mockResolvedValue({ code: 0, stdout: `User 501:\t${templates}\n`, stderr: '' })

    expect(await confirmBrowserPasswordOwner('show a saved password')).toBe(confirmed)
    expect(promptTouchID).not.toHaveBeenCalled()
  }
)
