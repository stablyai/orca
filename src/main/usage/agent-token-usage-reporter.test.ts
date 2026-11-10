import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTokenUsage } from '../../shared/telemetry-agent-token-usage-schema'
import { UsageCacheSnapshotWriter } from './usage-cache-snapshot-writer'
import { AgentTokenUsageReporter } from './agent-token-usage-reporter'

const ID = '00000000-0000-4000-8000-000000000001'
const row = {
  providerSessionId: 'private-provider-session',
  input_tokens: 100,
  output_tokens: 20,
  cached_input_tokens: 50,
  cache_write_input_tokens: 10
}
let directory: string
let file: string
const enabled = vi.fn(async () => true)
const capture = vi.fn(async (_snapshot: AgentTokenUsage) => true)
let reporters: AgentTokenUsageReporter[]
const identity = vi.fn(async (ids: readonly string[]) => ids.map(() => ID))
function reporter(): AgentTokenUsageReporter {
  const instance = new AgentTokenUsageReporter(file, 'claude', identity, {
    isEnabled: enabled,
    capture
  })
  reporters.push(instance)
  return instance
}
function captures() {
  return capture.mock.calls.map(([snapshot]) => snapshot)
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-token-usage-'))
  file = join(directory, 'tokens.json')
  enabled.mockReset().mockResolvedValue(true)
  capture.mockReset().mockResolvedValue(true)
  reporters = []
  identity.mockReset().mockImplementation(async (ids) => ids.map(() => ID))
})
afterEach(async () => {
  await Promise.all(reporters.map((instance) => instance.flush()))
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('agent token usage', () => {
  it('persists before capture, omits provider IDs, and retains revisions across restarts', async () => {
    capture.mockImplementation(() => {
      expect(JSON.parse(readFileSync(file, 'utf8')).snapshots[0].revision).toBeGreaterThan(0)
      return Promise.resolve(true)
    })
    const original = reporter()
    await original.report([row])
    await original.report([row])
    expect(captures()).toHaveLength(1)
    expect(captures()[0]).toMatchObject({
      analytics_session_id: ID,
      revision: 1,
      input_tokens: 100
    })
    expect(JSON.stringify(captures())).not.toContain(row.providerSessionId)
    await original.report([{ ...row, input_tokens: 150 }])
    expect(captures()[1]).toMatchObject({ revision: 2, input_tokens: 150 })
    await reporter().report([{ ...row, input_tokens: 150 }])
    expect(captures()).toHaveLength(3)
    await reporter().report([{ ...row, input_tokens: 90 }])
    expect(captures()[3]).toMatchObject({ revision: 3, input_tokens: 90 })
  })

  it('does no identity or disk work when consent is disabled', async () => {
    enabled.mockResolvedValue(false)
    await reporter().report([row])
    expect(identity).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
    expect(captures()).toEqual([])
  })

  it('rechecks consent after asynchronous identity persistence', async () => {
    identity.mockImplementation(async (ids) => {
      enabled.mockResolvedValue(false)
      return ids.map(() => ID)
    })
    await reporter().report([row])
    expect(captures()).toEqual([])
  })

  it('does not publish a revision whose write failed and retries it', async () => {
    const instance = reporter()
    const write = vi
      .spyOn(UsageCacheSnapshotWriter.prototype, 'write')
      .mockRejectedValueOnce(new Error('disk full'))
    await expect(instance.report([row])).rejects.toThrow('disk full')
    expect(captures()).toEqual([])
    write.mockRestore()
    await instance.report([row])
    expect(captures()[0]).toMatchObject({ revision: 1 })
  })

  it.each(['same process', 'restart'])(
    'retries rate-limited snapshots after %s without incrementing their revision',
    async (retry) => {
      let accepted = 0
      capture.mockImplementation(async () => ++accepted <= 30)
      const instance = reporter()
      for (let count = 1; count <= 31; count++) {
        await instance.report([{ ...row, input_tokens: count }])
      }
      expect(captures()).toHaveLength(31)
      capture.mockResolvedValue(true)
      const next = retry === 'restart' ? reporter() : instance
      await next.report([{ ...row, input_tokens: 31 }])
      expect(captures()).toHaveLength(32)
      expect(captures().at(-1)).toMatchObject({ revision: 31, input_tokens: 31 })
      await next.report([{ ...row, input_tokens: 31 }])
      expect(captures()).toHaveLength(32)
    }
  )

  it('retries saved snapshots without rewriting unchanged history', async () => {
    const { providerSessionId: _, ...counts } = row
    const persisted = JSON.stringify({
      schemaVersion: 1,
      snapshots: [{ ...counts, provider: 'claude', analytics_session_id: ID, revision: 7 }]
    })
    writeFileSync(file, persisted)
    const write = vi.spyOn(UsageCacheSnapshotWriter.prototype, 'write')
    const instance = reporter()
    await instance.report([row])
    await instance.report([])
    await instance.flush()
    expect(captures()).toEqual([expect.objectContaining({ revision: 7 })])
    expect(write).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(persisted)
    await instance.report([{ ...row, output_tokens: 21 }])
    expect(captures()[1]).toMatchObject({ revision: 8, output_tokens: 21 })
  })

  it.each(['duplicate', 'wrong-provider'])(
    'rejects %s snapshots without overwriting the file or capturing',
    async (invalid) => {
      await reporter().report([row])
      capture.mockClear()
      const state = JSON.parse(readFileSync(file, 'utf8'))
      if (invalid === 'duplicate') {
        state.snapshots.push(state.snapshots[0])
      }
      if (invalid === 'wrong-provider') {
        state.snapshots[0].provider = 'codex'
      }
      const content = JSON.stringify(state)
      writeFileSync(file, content)
      await expect(reporter().report([row])).rejects.toThrow()
      expect(readFileSync(file, 'utf8')).toBe(content)
      expect(captures()).toEqual([])
    }
  )

  it('rejects corrupt saved revisions without replacing them', async () => {
    writeFileSync(file, '{broken')
    await expect(reporter().report([row])).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{broken')
    expect(captures()).toEqual([])
  })
})
