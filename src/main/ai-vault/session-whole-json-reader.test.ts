import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AI_VAULT_WHOLE_JSON_MAX_BYTES,
  AI_VAULT_JSON_READ_MAX_ACTIVE,
  AI_VAULT_JSON_READ_MAX_WAITERS,
  AiVaultJsonReadBudget,
  withAiVaultWholeJsonFile
} from './session-whole-json-reader'

describe('AI Vault whole-JSON read budget', () => {
  it('queues aggregate bytes and releases admission idempotently', async () => {
    const budget = new AiVaultJsonReadBudget(10)
    const releaseSix = await budget.acquire(6)
    let admitted = false
    const second = budget.acquire(5).then((release) => {
      admitted = true
      return release
    })

    await Promise.resolve()
    expect(admitted).toBe(false)
    releaseSix()
    const releaseFive = await second
    expect(admitted).toBe(true)

    releaseSix()
    releaseFive()
    await expect(budget.acquire(10)).resolves.toEqual(expect.any(Function))
  })

  it('rejects a single document larger than the process budget', () => {
    const budget = new AiVaultJsonReadBudget(10)

    expect(() => budget.acquire(11)).toThrow('exceeds 10 byte limit')
  })

  it('bounds queued readers and admits them in FIFO order', async () => {
    const budget = new AiVaultJsonReadBudget(1)
    const releaseActive = await budget.acquire(1)
    const queued = Array.from({ length: AI_VAULT_JSON_READ_MAX_WAITERS }, () => budget.acquire(1))

    expect(() => budget.acquire(1)).toThrow('reader is busy')
    releaseActive()
    for (const pending of queued) {
      const release = await pending
      release()
    }
    await expect(budget.acquire(1)).resolves.toEqual(expect.any(Function))
  })

  it('uses a fixed active-reader pool even when byte capacity remains', async () => {
    const budget = new AiVaultJsonReadBudget(1024)
    const releases = await Promise.all(
      Array.from({ length: AI_VAULT_JSON_READ_MAX_ACTIVE }, () => budget.acquire(1))
    )
    let admitted = false
    const queued = budget.acquire(1).then((release) => {
      admitted = true
      return release
    })

    await Promise.resolve()
    expect(admitted).toBe(false)
    releases[0]()
    const releaseQueued = await queued
    expect(admitted).toBe(true)
    for (const release of releases.slice(1)) {
      release()
    }
    releaseQueued()
  })

  it('rejects an oversized sparse file before reading or parsing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-vault-whole-json-'))
    const path = join(directory, 'oversized.json')
    const handle = await open(path, 'w')
    await handle.truncate(AI_VAULT_WHOLE_JSON_MAX_BYTES + 1)
    await handle.close()
    const consume = vi.fn()

    try {
      await expect(withAiVaultWholeJsonFile(path, consume)).rejects.toThrow(
        `exceeds ${AI_VAULT_WHOLE_JSON_MAX_BYTES} byte limit`
      )
      expect(consume).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true })
    }
  })
})
