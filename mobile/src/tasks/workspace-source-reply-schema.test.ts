import { describe, expect, it } from 'vitest'
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
  it('takes every arm this build knows', () => {
    for (const status of [
      'disconnected',
      'connecting',
      'auth-failed',
      'deploying-relay',
      'connected',
      'reconnecting',
      'reconnection-failed',
      'error'
    ]) {
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
    expect(parsed.success && (parsed.data as { status: string }).status).not.toBe('connected')
  })

  it('stays fatal for a non-string status, which is the wrong type and not a newer arm', () => {
    const parsed = sshConnectionStateSchema.safeParse({ state: { ...connected, status: 7 } })
    expect(parsed.success && parsed.data).toBeUndefined()
  })
})

describe('error is a tri-state the drawer renders', () => {
  it('keeps an explicit null', () => {
    const parsed = sshConnectionStateSchema.safeParse({ state: connected })
    expect(parsed.success && (parsed.data as { error: unknown }).error).toBeNull()
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
