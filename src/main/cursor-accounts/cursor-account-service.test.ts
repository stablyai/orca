import { describe, expect, it, vi } from 'vitest'
import { cursorSnapshot, harness } from './cursor-account-test-fixtures'

describe('CursorAccountService', () => {
  it('lists a signed-in CLI as unsaved until it is saved', async () => {
    const h = harness()
    expect(await h.service.list()).toEqual({
      supported: true,
      accounts: [],
      activeAccountId: null,
      selectedAccountId: null,
      currentUnsaved: true
    })
    const saved = await h.service.addCurrent()
    expect(saved.accounts).toHaveLength(1)
    expect(saved.accounts[0]).toMatchObject({
      email: 'user_a@example.invalid',
      displayName: 'Name user_a',
      subject: 'user_a'
    })
    expect(saved.activeAccountId).toBe(saved.accounts[0].id)
    expect(saved.currentUnsaved).toBe(false)
    expect(JSON.stringify(saved)).not.toContain('refresh-user_a-1')
  })

  it('does not save the same account twice', async () => {
    const h = harness()
    await h.service.addCurrent()
    const again = await h.service.addCurrent()
    expect(again.accounts).toHaveLength(1)
  })

  it('refuses to save when the CLI is signed out', async () => {
    const h = harness(null)
    await expect(h.service.addCurrent()).rejects.toThrow('Sign in with cursor-agent')
  })

  it('switches every credential, including the refresh token and identity', async () => {
    const h = harness(cursorSnapshot('user_a', 1))
    const a = (await h.service.addCurrent()).accounts[0].id
    h.setNative(cursorSnapshot('user_b', 1, { apiKey: 'key-b' }))
    await h.service.addCurrent()

    const state = await h.service.select(a)

    expect(h.getNative()).toEqual(cursorSnapshot('user_a', 1))
    expect(state.activeAccountId).toBe(a)
    expect(state.selectedAccountId).toBe(a)
    expect(h.backend.write).toHaveBeenCalledWith(
      cursorSnapshot('user_a', 1),
      cursorSnapshot('user_b', 1, { apiKey: 'key-b' }).accessToken
    )
  })

  it('keeps the latest tokens of a saved account after cursor-agent refreshes them', async () => {
    const h = harness(cursorSnapshot('user_a', 1))
    const a = (await h.service.addCurrent()).accounts[0].id
    h.setNative(cursorSnapshot('user_a', 2))
    await h.service.list()
    h.setNative(cursorSnapshot('user_b', 1))
    await h.service.addCurrent()

    await h.service.select(a)

    expect(h.getNative()).toEqual(cursorSnapshot('user_a', 2))
  })

  it('never overwrites a sign-in that is not saved', async () => {
    const h = harness(cursorSnapshot('user_a', 1))
    const a = (await h.service.addCurrent()).accounts[0].id
    h.setNative(cursorSnapshot('user_b', 1))

    await expect(h.service.select(a)).rejects.toThrow('Save the current Cursor account')
    expect(h.getNative()).toEqual(cursorSnapshot('user_b', 1))
    expect(h.backend.write).not.toHaveBeenCalled()
  })

  it('fails when the CLI signs in elsewhere while switching', async () => {
    const h = harness(cursorSnapshot('user_a', 1))
    const a = (await h.service.addCurrent()).accounts[0].id
    h.setNative(cursorSnapshot('user_b', 1))
    await h.service.addCurrent()
    vi.mocked(h.backend.write).mockRejectedValueOnce(new Error('native conflict'))

    await expect(h.service.select(a)).rejects.toThrow('native conflict')
    expect(h.getVault().selectedAccountId).toBeNull()
  })

  it('rejects a switch the readback does not confirm', async () => {
    const h = harness(cursorSnapshot('user_a', 1))
    const a = (await h.service.addCurrent()).accounts[0].id
    h.setNative(cursorSnapshot('user_b', 1))
    await h.service.addCurrent()
    vi.mocked(h.backend.write).mockResolvedValueOnce()

    await expect(h.service.select(a)).rejects.toThrow('could not be verified')
    expect(h.getVault().selectedAccountId).toBeNull()
  })

  it('removes only accounts that are neither active nor selected', async () => {
    const h = harness(cursorSnapshot('user_a', 1))
    const a = (await h.service.addCurrent()).accounts[0].id
    h.setNative(cursorSnapshot('user_b', 1))
    const b = (await h.service.addCurrent()).accounts.find((account) => account.id !== a)!.id

    await expect(h.service.remove(b)).rejects.toThrow('Switch to another Cursor account')
    await h.service.select(a)
    expect((await h.service.remove(b)).accounts.map((account) => account.id)).toEqual([a])
    await expect(h.service.remove(a)).rejects.toThrow('Switch to another Cursor account')
    await expect(h.service.remove('missing')).rejects.toThrow('was not found')
  })

  it('serializes concurrent changes', async () => {
    const h = harness(cursorSnapshot('user_a', 1))
    await Promise.all([h.service.addCurrent(), h.service.addCurrent(), h.service.list()])
    expect(h.getVault().accounts).toHaveLength(1)
  })
})
