import { describe, expect, it } from 'vitest'
import { ExecutionHostNotDispatchableError } from './providers/execution-host-provider-dispatch'
import { SshHostNotServedError } from './providers/ssh-host-not-served-error'
import type { ExecutionHostId } from '../shared/execution-host'
import {
  resolveWorktreeRemovalHome,
  resolveWorktreeRemovalHomeForHost,
  resolveWorktreeRemovalRoute
} from './worktree-removal-execution-host-route'

describe('resolveWorktreeRemovalRoute', () => {
  it('routes a local host to this machine', () => {
    expect(resolveWorktreeRemovalRoute('local')).toEqual({ kind: 'local', hostId: 'local' })
  })

  it('refuses an SSH host with the typed not-served error instead of answering local', () => {
    expect(() => resolveWorktreeRemovalRoute('ssh:target-a')).toThrow(SshHostNotServedError)
  })

  it('refuses a runtime host with no nested SSH target', () => {
    expect(() => resolveWorktreeRemovalRoute('runtime:env-1')).toThrow(
      ExecutionHostNotDispatchableError
    )
  })
})

describe('resolveWorktreeRemovalHome', () => {
  it('keeps a local removal on this client s home', () => {
    expect(resolveWorktreeRemovalHome(resolveWorktreeRemovalRoute('local'))).toEqual({
      kind: 'client'
    })
  })
})

describe('resolveWorktreeRemovalHomeForHost', () => {
  it('never answers an ssh host id with this client s home', () => {
    expect(resolveWorktreeRemovalHomeForHost('ssh:target-a')).toEqual({
      kind: 'executionHost',
      homePath: null
    })
  })

  it('keeps the client home for the local host', () => {
    expect(resolveWorktreeRemovalHomeForHost('local')).toEqual({ kind: 'client' })
  })

  it('refuses to answer a runtime host with this client s home', () => {
    expect(resolveWorktreeRemovalHomeForHost('runtime:env-1')).toEqual({
      kind: 'executionHost',
      homePath: null
    })
  })

  it('refuses to answer an id that names no host', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: host ids also arrive from persistence and IPC, where the compiler cannot vouch for them; this pins what an unparseable one answers.
    expect(resolveWorktreeRemovalHomeForHost('nonsense' as ExecutionHostId)).toEqual({
      kind: 'executionHost',
      homePath: null
    })
  })
})
