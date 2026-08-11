import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginAuditLog } from './plugin-audit-log'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginAuditLog retention', () => {
  it('rotates bounded segments while preserving recent entries across the boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-audit-'))
    roots.push(root)
    const audit = new PluginAuditLog(root, { maxBytes: 240 })

    for (let index = 0; index < 8; index += 1) {
      await audit.record({
        ts: index,
        actor: 'plugin:orca-samples.demo',
        method: 'storage.set',
        summary: `key=${index}`,
        outcome: 'ok'
      })
    }

    await expect(stat(join(root, 'audit.log'))).resolves.toMatchObject({
      isFile: expect.any(Function)
    })
    await expect(stat(join(root, 'audit.log.1'))).resolves.toMatchObject({
      isFile: expect.any(Function)
    })
    const recent = await audit.readRecent(3)
    expect(recent.map((entry) => entry.ts)).toEqual([5, 6, 7])
  })
})
