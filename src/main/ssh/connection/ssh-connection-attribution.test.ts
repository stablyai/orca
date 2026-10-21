import { describe, expect, it } from 'vitest'
import type { SshConnection } from './ssh-connection'
import {
  adoptSshConnection,
  isSshConnectionSolelyOwnedBy,
  recordSshConnectionOpened,
  runAttributedToSshOwner
} from './ssh-connection-attribution'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution keys on identity only.
const transport = (): SshConnection => ({}) as SshConnection

describe('SSH transport attribution', () => {
  it('lets a cancelled attempt own only the transport its own work opened', async () => {
    const attempt = Symbol('a')
    const opened = transport()
    await runAttributedToSshOwner(attempt, async () => {
      await Promise.resolve()
      recordSshConnectionOpened(opened)
    })
    const unrelated = transport()
    recordSshConnectionOpened(unrelated)
    expect(isSshConnectionSolelyOwnedBy(opened, attempt)).toBe(true)
    expect(isSshConnectionSolelyOwnedBy(unrelated, attempt)).toBe(false)
  })

  it('gives the transport up once a completed replacement connect adopts it', async () => {
    const stale = Symbol('stale')
    const replacement = Symbol('replacement')
    const opened = transport()
    await runAttributedToSshOwner(stale, async () => recordSshConnectionOpened(opened))
    adoptSshConnection(opened, replacement)
    expect(isSshConnectionSolelyOwnedBy(opened, stale)).toBe(false)
  })

  it('gives the transport up once a managed tunnel outside any attempt relies on it', async () => {
    const stale = Symbol('stale')
    const opened = transport()
    await runAttributedToSshOwner(stale, async () => recordSshConnectionOpened(opened))
    adoptSshConnection(opened)
    expect(isSshConnectionSolelyOwnedBy(opened, stale)).toBe(false)
  })

  it('keeps the transport the attempt’s own tunnel adopted inside its decision', async () => {
    const attempt = Symbol('a')
    const opened = transport()
    await runAttributedToSshOwner(attempt, async () => {
      recordSshConnectionOpened(opened)
      adoptSshConnection(opened)
    })
    expect(isSshConnectionSolelyOwnedBy(opened, attempt)).toBe(true)
  })
})
