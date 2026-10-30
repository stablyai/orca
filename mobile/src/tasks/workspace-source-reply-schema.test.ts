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

const connected = {
  targetId: 'ssh-1',
  status: 'connected',
  error: null,
  reconnectAttempt: 0
}

describe('the SSH connection record', () => {
  it('reads the representative connected state whole', () => {
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

  it('keeps the record when its managed-server note is malformed', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { ...connected, managedServer: { serving: { detail: 7 } } }
    })
    expect(parsed.success && parsed.data).toMatchObject({ status: 'connected' })
    expect(parsed.success && parsed.data?.managedServer?.serving?.detail).toBeUndefined()
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
  // Independent wire values keep a removed schema arm in the test domain.
  it('takes every arm the host declares, so nothing it sends today degrades', () => {
    for (const status of [
      'disconnected',
      'connecting',
      'auth-failed',
      'deploying-relay',
      'connected',
      'reconnecting',
      'reconnection-failed',
      'error'
    ] as const) {
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

  it('stays fatal for a non-string status, which is the wrong type and not a newer arm', () => {
    const parsed = sshConnectionStateSchema.safeParse({ state: { ...connected, status: 7 } })
    expect(parsed.success && parsed.data).toBeUndefined()
  })
})

// Unknown SSH states must degrade to the same disconnected/readiness verdicts every consumer already uses.
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

  it('keeps a record that omits error, because no reader needs it', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { targetId: 'ssh-1', status: 'auth-failed', reconnectAttempt: 0 }
    })
    expect(parsed.success && parsed.data).toMatchObject({ status: 'auth-failed' })
  })
})

// One fatal member drops the whole state and triggers connected fallback; unread fields must not invalidate an auth-failed record.
describe('a partial record survives with the status it came with', () => {
  it('keeps a record that omits reconnectAttempt, which nothing reads', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { targetId: 'ssh-1', status: 'auth-failed', error: 'bad key' }
    })
    expect(parsed.success && parsed.data).toMatchObject({
      targetId: 'ssh-1',
      status: 'auth-failed',
      error: 'bad key'
    })
  })

  it('never lets a partial record reach the gate as connected', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { targetId: 'ssh-1', status: 'auth-failed', error: 'bad key' }
    })
    const gate = deriveWorkspaceSshGate({
      connectionId: 'ssh-1',
      connecting: false,
      state: parsed.success ? (parsed.data ?? null) : null
    })
    expect(gate.status).toBe('auth-failed')
    expect(gate.requiresConnection).toBe(true)
  })

  it('still drops the record for a member the gate does read', () => {
    const parsed = sshConnectionStateSchema.safeParse({
      state: { status: 'connected', error: null, reconnectAttempt: 0 }
    })
    expect(parsed.success && parsed.data).toBeUndefined()
  })
})

describe('a sparse preset requires what the drawer sorts and joins', () => {
  const preset = { id: 'p1', name: 'docs', directories: ['docs'] }

  it('reads the representative preset whole', () => {
    expect(repoSparsePresetListSchema.safeParse({ presets: [preset] })).toMatchObject({
      success: true,
      data: [preset]
    })
  })

  it('drops a preset with no name, which the list sorts with localeCompare', () => {
    const { name: _name, ...noName } = preset
    const parsed = repoSparsePresetListSchema.safeParse({ presets: [preset, noName] })
    expect(parsed.success && parsed.data).toEqual([preset])
  })

  it('drops a preset with no directories, which the picker joins', () => {
    const { directories: _directories, ...noDirectories } = preset
    const parsed = repoSparsePresetListSchema.safeParse({ presets: [preset, noDirectories] })
    expect(parsed.success && parsed.data).toEqual([preset])
  })

  it('drops a non-string directory and keeps the preset', () => {
    const parsed = repoSparsePresetListSchema.safeParse({
      presets: [{ ...preset, directories: ['docs', 7] }]
    })
    expect(parsed.success && parsed.data).toEqual([preset])
  })
})

describe('detected agent ids', () => {
  it('reads the representative probe answers', () => {
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
  it('reads the representative reply for a repo with no setup script and no source', () => {
    expect(repoSetupHooksSchema.safeParse({ hooks: { scripts: {} } }).success).toBe(true)
  })

  it('reads the representative reply with an explicit null setupTrust', () => {
    const parsed = repoSetupHooksSchema.safeParse({
      hooks: { scripts: { setup: 'pnpm install' } },
      source: 'repo',
      setupRunPolicy: 'ask',
      setupTrust: null
    })
    expect(parsed.success && parsed.data).toMatchObject({ setupTrust: null })
  })

  it('reads a setupRunPolicy this build has never heard of as skip-by-default', () => {
    const parsed = repoSetupHooksSchema.safeParse({ setupRunPolicy: 'prompt-twice' })
    expect(parsed.success && parsed.data).toMatchObject({ setupRunPolicy: 'skip-by-default' })
  })

  it('keeps the untrimmed setup script the representative reply carries', () => {
    const parsed = repoSetupHooksSchema.safeParse({ hooks: { scripts: { setup: '  pnpm i  ' } } })
    expect(parsed.success && parsed.data).toMatchObject({
      hooks: { scripts: { setup: '  pnpm i  ' } }
    })
  })
})

describe('sparse presets', () => {
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
  it('reads both representative shapes', () => {
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
