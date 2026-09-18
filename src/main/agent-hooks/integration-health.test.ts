import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { IntegrationHealthStore } from './integration-health'

describe('IntegrationHealthStore', () => {
  it('persists bounded artifact identity and reloads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'integration-health-'))
    const filePath = join(dir, 'health.json')
    const store = new IntegrationHealthStore({ filePath, now: () => 1000, maxRecords: 1 })
    const one = store.recordArtifact({
      integration: 'auggie',
      host: 'local',
      scope: 'settings',
      bytes: 'one'
    })
    expect(one.digest).toHaveLength(64)
    expect(one.byteLength).toBe(3)
    store.recordArtifact({ integration: 'opencode', host: 'local', scope: 'pane', bytes: 'two' })
    expect(store.snapshot()).toHaveLength(1)
    expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(1)
    expect(
      new IntegrationHealthStore({ filePath, now: () => 1000 }).get('opencode', 'local', 'pane')
        ?.artifact
    ).toBe('current')
  })

  it('expires records so durable obligations have an exit', () => {
    let now = 100
    const store = new IntegrationHealthStore({
      filePath: join(mkdtempSync(join(tmpdir(), 'integration-health-')), 'h.json'),
      now: () => now,
      ttlMs: 10
    })
    store.recordArtifact({ integration: 'auggie', host: 'remote', scope: 'settings', bytes: 'x' })
    now = 111
    expect(store.snapshot()).toEqual([])
  })

  it('merges records from stores that loaded before either writer persisted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'integration-health-'))
    const filePath = join(dir, 'health.json')
    const first = new IntegrationHealthStore({ filePath, now: () => 1000 })
    const second = new IntegrationHealthStore({ filePath, now: () => 1000 })
    expect(second.snapshot()).toEqual([])
    first.recordArtifact({ integration: 'opencode', host: 'local', scope: 'one', bytes: '1' })
    second.recordArtifact({ integration: 'auggie', host: 'local', scope: 'two', bytes: '2' })
    expect(new IntegrationHealthStore({ filePath, now: () => 1000 }).snapshot()).toHaveLength(2)
  })

  it('records loader and delivery only when an explicit producer reports them', () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'integration-health-')), 'h.json')
    const store = new IntegrationHealthStore({ filePath, now: () => 1000 })
    const current = store.recordArtifact({
      integration: 'opencode',
      host: 'local',
      scope: 'pane',
      bytes: 'source',
      version: '1.18.31'
    })
    expect(current.loader).toBe('unknown')
    expect(current.delivery).toBe('unobserved')
    const receipt = store.recordDeliveryEvidence({
      integration: 'opencode',
      host: 'local',
      scope: 'pane',
      artifactId: current.artifactId,
      version: current.version,
      executionId: 'exec-1',
      loader: 'loaded',
      delivery: 'observed'
    })
    expect(receipt.loader).toBe('loaded')
    expect(receipt.delivery).toBe('observed')
  })

  it('keeps receipt identity per artifact version and execution across writers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'integration-health-'))
    const filePath = join(dir, 'h.json')
    const first = new IntegrationHealthStore({ filePath, now: () => 1000 })
    const second = new IntegrationHealthStore({ filePath, now: () => 1000 })
    first.recordDeliveryEvidence({
      integration: 'opencode',
      host: 'remote',
      scope: 'pane-a',
      artifactId: 'opencode:1',
      version: '1',
      executionId: 'exec-a',
      loader: 'loaded',
      delivery: 'observed'
    })
    second.recordDeliveryEvidence({
      integration: 'opencode',
      host: 'remote',
      scope: 'pane-b',
      artifactId: 'opencode:2',
      version: '2',
      executionId: 'exec-b',
      loader: 'unknown',
      delivery: 'failed'
    })
    const snapshot = new IntegrationHealthStore({ filePath, now: () => 1000 }).snapshot()
    expect(snapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: 'opencode:1',
          executionId: 'exec-a',
          loader: 'loaded'
        }),
        expect.objectContaining({
          artifactId: 'opencode:2',
          executionId: 'exec-b',
          loader: 'unknown',
          delivery: 'failed'
        })
      ])
    )
  })
})
