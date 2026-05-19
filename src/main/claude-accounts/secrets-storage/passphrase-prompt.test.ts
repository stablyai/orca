import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createPassphraseHolder,
  promptForPassphrase,
  resetPassphraseHolderForTest
} from './passphrase-prompt'

// Why: dialog/BrowserWindow mocked at the boundary so this test runs without Electron.
const showPassphrasePromptMock =
  vi.fn<(args: { mode: 'unlock' | 'create'; attempt: number }) => Promise<string | null>>()
vi.mock('./passphrase-dialog', () => ({
  showPassphrasePrompt: (args: { mode: 'unlock' | 'create'; attempt: number }) =>
    showPassphrasePromptMock(args)
}))

describe('passphrase-prompt', () => {
  beforeEach(() => {
    showPassphrasePromptMock.mockReset()
    resetPassphraseHolderForTest()
  })

  it('holder caches passphrase after first set', () => {
    const holder = createPassphraseHolder()
    expect(holder.get()).toBeNull()
    holder.set('hunter2')
    expect(holder.get()).toBe('hunter2')
  })

  it('holder.clear zeroes the cached value', () => {
    const holder = createPassphraseHolder()
    holder.set('hunter2')
    holder.clear()
    expect(holder.get()).toBeNull()
  })

  it('promptForPassphrase returns cached value without dialog', async () => {
    const holder = createPassphraseHolder()
    holder.set('hunter2')
    const result = await promptForPassphrase({ mode: 'unlock', holder })
    expect(result).toBe('hunter2')
    expect(showPassphrasePromptMock).not.toHaveBeenCalled()
  })

  it('promptForPassphrase prompts up to 3 attempts on unlock failure', async () => {
    const holder = createPassphraseHolder()
    const verifier = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    showPassphrasePromptMock
      .mockResolvedValueOnce('bad1')
      .mockResolvedValueOnce('bad2')
      .mockResolvedValueOnce('good')
    const result = await promptForPassphrase({ mode: 'unlock', holder, verifier })
    expect(result).toBe('good')
    expect(holder.get()).toBe('good')
    expect(verifier).toHaveBeenCalledTimes(3)
  })

  it('returns null after 3 wrong attempts and disables feature for session', async () => {
    const holder = createPassphraseHolder()
    const verifier = vi.fn().mockResolvedValue(false)
    showPassphrasePromptMock
      .mockResolvedValueOnce('bad1')
      .mockResolvedValueOnce('bad2')
      .mockResolvedValueOnce('bad3')
    const result = await promptForPassphrase({ mode: 'unlock', holder, verifier })
    expect(result).toBeNull()
    expect(holder.get()).toBeNull()
  })

  it('mode=create requires confirmation match', async () => {
    const holder = createPassphraseHolder()
    showPassphrasePromptMock.mockResolvedValueOnce('newpass\nnewpass')
    const result = await promptForPassphrase({ mode: 'create', holder })
    expect(result).toBe('newpass')
  })

  it('mode=create with mismatching confirmation re-prompts', async () => {
    const holder = createPassphraseHolder()
    showPassphrasePromptMock
      .mockResolvedValueOnce('newpass\notherpass')
      .mockResolvedValueOnce('newpass\nnewpass')
    const result = await promptForPassphrase({ mode: 'create', holder })
    expect(result).toBe('newpass')
  })

  it('returns null when user cancels dialog', async () => {
    const holder = createPassphraseHolder()
    showPassphrasePromptMock.mockResolvedValueOnce(null)
    const result = await promptForPassphrase({ mode: 'unlock', holder })
    expect(result).toBeNull()
  })
})
