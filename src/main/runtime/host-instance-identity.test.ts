import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadOrCreateE2EEKeypair } from './e2ee-keypair'
import { DeviceRegistry } from './rpc/server/pairing/device-registry'
import { ensureHostInstanceIdentity } from './host-instance-identity'

const NOW = new Date('2026-01-02T03:04:05.678Z')
const MARKER = 'orca-host-instance.json'
const IDENTITY_FILES = ['orca-e2ee-keypair.json', 'orca-devices.json', 'host-installation.json']

function serve(dir: string, env: NodeJS.ProcessEnv) {
  const verdict = ensureHostInstanceIdentity(dir, env, NOW)
  return {
    verdict,
    registry: new DeviceRegistry(dir),
    publicKeyB64: loadOrCreateE2EEKeypair(dir).publicKeyB64
  }
}

function pairedHost(dir: string, env: NodeJS.ProcessEnv) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'host-installation.json'), JSON.stringify({ installationId: 'inst-1' }))
  const host = serve(dir, env)
  const { token } = host.registry.addDevice('Phone')
  host.registry.flushPendingLastSeen()
  return { publicKeyB64: host.publicKeyB64, token }
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => IDENTITY_FILES.includes(name))
      .map((name) => [name, readFileSync(join(dir, name), 'utf8')])
  )
}

describe('ensureHostInstanceIdentity', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-host-instance-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('does nothing when ORCA_INSTANCE_ID is unset or blank', () => {
    const dir = join(root, 'a')
    pairedHost(dir, {})
    const before = snapshot(dir)

    expect(ensureHostInstanceIdentity(dir, {}, NOW)).toEqual({ kind: 'disabled' })
    expect(ensureHostInstanceIdentity(dir, { ORCA_INSTANCE_ID: '  ' }, NOW)).toEqual({
      kind: 'disabled'
    })
    expect(existsSync(join(dir, MARKER))).toBe(false)
    expect(snapshot(dir)).toEqual(before)
  })

  it('only records the instance the first time ORCA_INSTANCE_ID is set', () => {
    const dir = join(root, 'a')
    const first = pairedHost(dir, {})
    const before = snapshot(dir)

    const host = serve(dir, { ORCA_INSTANCE_ID: 'vm-a' })
    expect(host.verdict).toEqual({ kind: 'recorded' })
    expect(host.publicKeyB64).toBe(first.publicKeyB64)
    expect(snapshot(dir)).toEqual(before)
    expect(readFileSync(join(dir, MARKER), 'utf8')).not.toContain('vm-a')
  })

  it('keeps the identity across restarts with the same instance id', () => {
    const dir = join(root, 'a')
    const first = pairedHost(dir, { ORCA_INSTANCE_ID: 'vm-a' })

    const restarted = serve(dir, { ORCA_INSTANCE_ID: 'vm-a' })
    expect(restarted.verdict).toEqual({ kind: 'unchanged' })
    expect(restarted.publicKeyB64).toBe(first.publicKeyB64)
    expect(restarted.registry.validateToken(first.token)).not.toBeNull()
  })

  it('moves a cloned identity aside when the instance id changes', () => {
    const golden = join(root, 'golden')
    const source = pairedHost(golden, { ORCA_INSTANCE_ID: 'vm-a' })
    const before = snapshot(golden)
    const clone = join(root, 'clone')
    cpSync(golden, clone, { recursive: true })

    const cloned = serve(clone, { ORCA_INSTANCE_ID: 'vm-b' })
    const backupDir = join(
      clone,
      `orca-host-identity-backup-2026-01-02T03-04-05-678Z-${process.pid}`
    )
    expect(cloned.verdict).toEqual({ kind: 'rotated', backupDir })
    expect(cloned.publicKeyB64).not.toBe(source.publicKeyB64)
    expect(cloned.registry.validateToken(source.token)).toBeNull()
    expect(cloned.registry.listDevices()).toEqual([])
    expect(existsSync(join(clone, 'host-installation.json'))).toBe(false)
    expect(snapshot(backupDir)).toEqual(before)

    const restarted = serve(clone, { ORCA_INSTANCE_ID: 'vm-b' })
    expect(restarted.verdict).toEqual({ kind: 'unchanged' })
    expect(restarted.publicKeyB64).toBe(cloned.publicKeyB64)
    // A start without the env var keeps whatever identity is current.
    expect(serve(clone, {}).publicKeyB64).toBe(cloned.publicKeyB64)
  })

  it('re-records a corrupt marker without rotating', () => {
    const dir = join(root, 'a')
    const first = pairedHost(dir, { ORCA_INSTANCE_ID: 'vm-a' })
    writeFileSync(join(dir, MARKER), '{not json')

    const host = serve(dir, { ORCA_INSTANCE_ID: 'vm-b' })
    expect(host.verdict).toEqual({ kind: 'recorded' })
    expect(host.publicKeyB64).toBe(first.publicKeyB64)
    expect(serve(dir, { ORCA_INSTANCE_ID: 'vm-b' }).verdict).toEqual({ kind: 'unchanged' })
  })

  it('keeps the identity when the marker cannot be read', () => {
    const dir = join(root, 'a')
    const first = pairedHost(dir, {})
    mkdirSync(join(dir, MARKER))

    const host = serve(dir, { ORCA_INSTANCE_ID: 'vm-a' })
    expect(host.verdict).toEqual({ kind: 'unverified' })
    expect(host.publicKeyB64).toBe(first.publicKeyB64)
  })

  it('throws without updating the marker when a rotation cannot complete, then retries', () => {
    const dir = join(root, 'a')
    const first = pairedHost(dir, { ORCA_INSTANCE_ID: 'vm-a' })
    const blocker = join(dir, `orca-host-identity-backup-2026-01-02T03-04-05-678Z-${process.pid}`)
    writeFileSync(blocker, '')

    expect(() => ensureHostInstanceIdentity(dir, { ORCA_INSTANCE_ID: 'vm-b' }, NOW)).toThrow()
    expect(loadOrCreateE2EEKeypair(dir).publicKeyB64).toBe(first.publicKeyB64)

    rmSync(blocker)
    expect(ensureHostInstanceIdentity(dir, { ORCA_INSTANCE_ID: 'vm-b' }, NOW).kind).toBe('rotated')
  })
})
