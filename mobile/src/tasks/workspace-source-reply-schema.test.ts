import { describe, expect, it } from 'vitest'
import type { SshConnectionStatus } from '../../../src/shared/ssh-types'
import { deriveWorkspaceSshGate, workspaceSshStatusLabel } from './workspace-ssh-gate'
import {
  detectedAgentIdsSchema,
  repoBaseRefSearchSchema,
  repoSetupHooksSchema,
  repoSparsePresetListSchema,
  repoSparsePresetSaveSchema,
  sshConnectionStateSchema
} from './workspace-source-reply-schema'

// Pins the SSH status degrade, the error tri-state beside it, and the preset requirement.

const connected = {
  targetId: 'ssh-1',
  status: 'connected',
  error: null,
  reconnectAttempt: 0
}

describe('the SSH connection record', () => {
  it('reads the recorded connected state whole', () => {
    expect(sshConnectionStateSchema.safeParse({ state: connected })).toMatchObject({
      success: true,
      data: connected
    })
  })

  it('keeps the connectionGeneration the file-mutation owner check reads', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { ...connected, connectionGeneration: 3 }
    })
    expect(parsed.success && parsed.data).toMatchObject({ connectionGeneration: 3 })
  })

  it('forwards members no consumer in this domain declares', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { ...connected, providerEpoch: 'epoch-1', remotePlatform: 'linux' }
    })
    expect(parsed.success && parsed.data).toMatchObject({
      providerEpoch: 'epoch-1',
      remotePlatform: 'linux'
    })
  })

  it('answers undefined for a payload with no state member', () => {
    expect(sshConnectionStateSchema.safeParse({})).toMatchObject({ success: true, data: undefined })
  })

  it('keeps an explicit null state, which the drawer falls back from', () => {
    expect(sshConnectionStateSchema.safeParse({ state: null })).toMatchObject({
      success: true,
      data: null
    })
  })
})

describe('status is an open enum that degrades to disconnected', () => {
  // Keyed by SshConnectionStatus so the compiler, not this list, decides what "every arm" means:
  // an arm added to or removed from the host union fails tsc here before any test runs. That is
  // the check the schema's own arm list cannot make about itself.
  const HOST_ARMS: Record<SshConnectionStatus, true> = {
    disconnected: true,
    connecting: true,
    'auth-failed': true,
    'deploying-relay': true,
    connected: true,
    reconnecting: true,
    'reconnection-failed': true,
    error: true
  }

  it('takes every arm the host declares, so nothing it sends today degrades', () => {
    for (const status of Object.keys(HOST_ARMS)) {
      const parsed = sshConnectionStateSchema.safeParse({ state: { ...connected, status } })
      expect(parsed.success && parsed.data).toMatchObject({ status })
    }
  })

  it('degrades an arm it has never heard of, keeping the record and the Connect affordance', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { ...connected, status: 'handshaking-v2' }
    })
    expect(parsed.success && parsed.data).toMatchObject({
      targetId: 'ssh-1',
      status: 'disconnected'
    })
  })

  it('never degrades a newer arm to connected', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { ...connected, status: 'whatever' }
    })
    expect(parsed.success ? parsed.data?.status : 'unparsed').not.toBe('connected')
  })

  it('stays fatal for a non-string status, which is the wrong type and not a newer arm', () => {
    const parsed = sshConnectionStateSchema.safeParse({ state: { ...connected, status: 7 } })
    expect(parsed.success && parsed.data).toBeUndefined()
  })
})

// The degrade above is only allowed because it is invisible to every reader. Main passed an arm it
// did not know straight through as a string; these pin that the degraded value reaches the same
// verdict, so a newer host's arm renders what main rendered.
describe('the degrade is inert at the gate that reads status', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: models the status arm a newer host sends, which is precisely what SshConnectionStatus cannot express: the union names every arm this build knows, so the value under test has to enter as one the compiler would reject.
  const newerArm = 'handshaking-v2' as SshConnectionStatus

  it('labels a newer arm and the degraded value identically', () => {
    expect(workspaceSshStatusLabel('disconnected')).toBe('Disconnected')
    expect(workspaceSshStatusLabel(newerArm)).toBe(workspaceSshStatusLabel('disconnected'))
  })

  it('gates a newer arm and the degraded value identically', () => {
    const gateArgs = { connectionId: 'ssh-1', connecting: false }
    const asMainSawIt = deriveWorkspaceSshGate({
      ...gateArgs,
      state: { ...connected, status: newerArm, error: null }
    })
    const parsed = sshConnectionStateSchema.safeParse({ state: { ...connected, status: newerArm } })
    const afterDegrade = deriveWorkspaceSshGate({
      ...gateArgs,
      state: parsed.success ? (parsed.data ?? null) : null
    })
    expect(afterDegrade.requiresConnection).toBe(asMainSawIt.requiresConnection)
    expect(afterDegrade.connectInProgress).toBe(asMainSawIt.connectInProgress)
    expect(afterDegrade.error).toBe(asMainSawIt.error)
    expect(workspaceSshStatusLabel(afterDegrade.status)).toBe(
      workspaceSshStatusLabel(asMainSawIt.status)
    )
  })
})

describe('error is a tri-state the drawer renders', () => {
  it('keeps an explicit null', () => {
    const parsed = sshConnectionStateSchema.safeParse({ state: connected })
    expect(parsed.success ? parsed.data?.error : 'unparsed').toBeNull()
  })

  it('keeps the host message', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { ...connected, status: 'error', error: 'auth failed' }
    })
    expect(parsed.success && parsed.data).toMatchObject({ error: 'auth failed' })
  })

  it('drops the record when error is absent, because the drawer renders it unguarded', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { targetId: 'ssh-1', status: 'connected', reconnectAttempt: 0 }
    })
    expect(parsed.success && parsed.data).toBeUndefined()
  })
})

describe('detected agent ids', () => {
  it('reads the recorded probe answers', () => {
    expect(detectedAgentIdsSchema.safeParse(['codex', 'claude'])).toMatchObject({
      success: true,
      data: ['codex', 'claude']
    })
  })

  it('drops a non-string id, which no agent comparison could have matched', () => {
    expect(detectedAgentIdsSchema.safeParse(['codex', 7])).toMatchObject({ data: ['codex'] })
  })

  it('names a payload the drawer would have built a Set from', () => {
    expect(detectedAgentIdsSchema.safeParse(7).success).toBe(false)
    expect(detectedAgentIdsSchema.safeParse({ agents: [] }).success).toBe(false)
  })
})

describe('the orca.yaml hooks require nothing', () => {
  it('reads the recorded reply for a repo with no setup script and no source', () => {
    expect(repoSetupHooksSchema.safeParse({ hooks: { scripts: {} } }).success).toBe(true)
  })

  it('reads the recorded reply with an explicit null setupTrust', () => {
    const parsed = repoSetupHooksSchema.safeParse({
      hooks: { scripts: { setup: 'pnpm install' } },
      source: 'repo',
      setupRunPolicy: 'ask',
      setupTrust: null
    })
    expect(parsed.success && parsed.data).toMatchObject({ setupTrust: null })
  })

  it('keeps a setupRunPolicy this build has never heard of on the skip arm', () => {
    const parsed = repoSetupHooksSchema.safeParse({ setupRunPolicy: 'prompt-twice' })
    expect(parsed.success && parsed.data).toMatchObject({ setupRunPolicy: 'prompt-twice' })
  })

  it('keeps the untrimmed setup script the recorded reply carries', () => {
    const parsed = repoSetupHooksSchema.safeParse({ hooks: { scripts: { setup: '  pnpm i  ' } } })
    expect(parsed.success && parsed.data).toMatchObject({
      hooks: { scripts: { setup: '  pnpm i  ' } }
    })
  })
})

describe('sparse presets', () => {
  it('reads the recorded preset, which carries no repoId or timestamps', () => {
    const parsed = repoSparsePresetListSchema.safeParse({
      presets: [{ id: 'p1', name: 'docs', directories: ['docs'] }]
    })
    expect(parsed.success && parsed.data).toEqual([
      { id: 'p1', name: 'docs', directories: ['docs'] }
    ])
  })

  it('drops a preset with no id, which the picker could not select', () => {
    const parsed = repoSparsePresetListSchema.safeParse({ presets: [{ name: 'docs' }] })
    expect(parsed.success && parsed.data).toEqual([])
  })

  it('keeps the save path that answers no preset at all', () => {
    expect(repoSparsePresetSaveSchema.safeParse({})).toMatchObject({
      success: true,
      data: undefined
    })
  })
})

describe('base-ref search requires neither member', () => {
  it('reads both recorded shapes', () => {
    expect(repoBaseRefSearchSchema.safeParse({ refs: ['main'] }).success).toBe(true)
    expect(
      repoBaseRefSearchSchema.safeParse({
        refDetails: [{ refName: 'origin/main', localBranchName: 'main' }]
      }).success
    ).toBe(true)
  })

  it('drops a non-string ref rather than rendering it as a branch row', () => {
    const parsed = repoBaseRefSearchSchema.safeParse({ refs: ['main', 7] })
    expect(parsed.success && parsed.data).toMatchObject({ refs: ['main'] })
  })
})
