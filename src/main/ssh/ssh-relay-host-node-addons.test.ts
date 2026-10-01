import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
import type { SshConnection } from './ssh-connection'
import { HOST_NODE_RELAY_RUNTIME_KEY, planHostNodeAddonRelay } from './ssh-relay-host-node-addons'
import {
  pinnedNodeRelayFullVersion,
  pinnedRelayAddonFiles,
  RELAY_RUNTIME_REF_PREFIX
} from './ssh-relay-pinned-node'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const conn = {} as SshConnection
const linux = getRemoteHostPlatform('linux-x64')
const facts = { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 31 } }
const dirs: string[] = []

function fakeOrcadSlot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-slot-'))
  dirs.push(dir)
  for (const file of pinnedRelayAddonFiles('linux-x64-glibc')) {
    const path = join(dir, ...file.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file)
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const hostNode = {
  nodePath: '/usr/bin/node',
  facts: { version: { major: 20, minor: 11 }, napi: 9 }
}

describe('planHostNodeAddonRelay (rung C)', () => {
  it('stages the slot addons without a pinned runtime ref, under a version apart from rung A', async () => {
    const slot = fakeOrcadSlot()
    const resolveHostNode = vi.fn().mockResolvedValue(hostNode)
    const plan = await planHostNodeAddonRelay({
      conn,
      host: linux,
      facts,
      baseVersion: '0.1.0+abcdef012345',
      materializeOrcad: async () => slot,
      resolveHostNode
    })
    try {
      expect(resolveHostNode).toHaveBeenCalledWith(conn, 8, { signal: undefined })
      expect(plan.nodePath).toBe('/usr/bin/node')
      expect(plan.fullVersion).toBe(
        pinnedNodeRelayFullVersion(
          '0.1.0+abcdef012345',
          HOST_NODE_RELAY_RUNTIME_KEY,
          plan.addons.digest
        )
      )
      expect(plan.fullVersion).not.toBe(
        pinnedNodeRelayFullVersion(
          '0.1.0+abcdef012345',
          NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256,
          plan.addons.digest
        )
      )
      expect(readdirSync(plan.addons.dir).some((f) => f.startsWith(RELAY_RUNTIME_REF_PREFIX))).toBe(
        false
      )
    } finally {
      await plan.addons.dispose()
    }
  })

  it('refuses with host_node_missing when no qualifying host Node answered', async () => {
    await expect(
      planHostNodeAddonRelay({
        conn,
        host: linux,
        facts,
        baseVersion: '0.1.0+abcdef012345',
        resolveHostNode: vi.fn().mockResolvedValue(null)
      })
    ).rejects.toMatchObject({ reason: 'host_node_missing' })
  })

  it('refuses below the addons glibc floor before probing for a Node', async () => {
    const resolveHostNode = vi.fn()
    await expect(
      planHostNodeAddonRelay({
        conn,
        host: linux,
        facts: { ...facts, glibc: { major: 2, minor: 17 } },
        baseVersion: '0.1.0+abcdef012345',
        resolveHostNode
      })
    ).rejects.toMatchObject({ reason: 'libc_floor' })
    expect(resolveHostNode).not.toHaveBeenCalled()
  })

  it('lets an unanswered host Node probe propagate instead of stepping down', async () => {
    const lost = new Error('channel lost')
    await expect(
      planHostNodeAddonRelay({
        conn,
        host: linux,
        facts,
        baseVersion: '0.1.0+abcdef012345',
        resolveHostNode: vi.fn().mockRejectedValue(lost)
      })
    ).rejects.toBe(lost)
  })
})
