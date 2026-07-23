import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('AI Vault session discovery retention', () => {
  it('retains only the newest requested files while traversing nested directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-discovery-'))
    tempRoots.push(root)
    const nested = join(root, 'nested')
    await mkdir(nested)

    for (let index = 0; index < 40; index += 1) {
      const path = join(index % 2 === 0 ? root : nested, `session-${index}.jsonl`)
      await writeFile(path, '{}\n')
      const timestamp = new Date(1_700_000_000_000 + index * 1_000)
      await utimes(path, timestamp, timestamp)
    }

    const result = await discoverFiles({
      rootDir: root,
      limit: 3,
      agent: 'codex',
      issues: [],
      extensions: ['.jsonl']
    })

    expect(result.files).toHaveLength(3)
    expect(result.files.map((file) => basename(file.path))).toEqual([
      'session-39.jsonl',
      'session-38.jsonl',
      'session-37.jsonl'
    ])
  })

  it('returns no retained paths when the requested limit is zero', async () => {
    const result = await discoverFiles({
      rootDir: join('path', 'that', 'does-not-need-to-be-read'),
      limit: 0,
      agent: 'codex',
      issues: [],
      extensions: ['.jsonl']
    })

    expect(result.files).toEqual([])
  })

  it('accepts the exact aggregate entry capacity without changing results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-discovery-'))
    tempRoots.push(root)
    await Promise.all([
      writeFile(join(root, 'session-a.jsonl'), '{}\n'),
      writeFile(join(root, 'session-b.jsonl'), '{}\n')
    ])
    const issues: AiVaultScanIssue[] = []

    const result = await discoverFiles({
      rootDir: root,
      limit: 10,
      agent: 'codex',
      issues,
      extensions: ['.jsonl'],
      limits: { maxEntries: 2 }
    })

    expect(result.files.map((file) => basename(file.path)).sort()).toEqual([
      'session-a.jsonl',
      'session-b.jsonl'
    ])
    expect(issues).toEqual([])
  })

  it('reports aggregate entry overflow and releases the open directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-discovery-'))
    tempRoots.push(root)
    await Promise.all([
      writeFile(join(root, 'session-a.jsonl'), '{}\n'),
      writeFile(join(root, 'session-b.jsonl'), '{}\n'),
      writeFile(join(root, 'session-c.jsonl'), '{}\n')
    ])
    const issues: AiVaultScanIssue[] = []

    const result = await discoverFiles({
      rootDir: root,
      limit: 10,
      agent: 'codex',
      issues,
      extensions: ['.jsonl'],
      limits: { maxEntries: 2 }
    })

    const retainedNames = result.files.map((file) => basename(file.path))
    expect(retainedNames).toHaveLength(2)
    expect(
      retainedNames.every((name) =>
        ['session-a.jsonl', 'session-b.jsonl', 'session-c.jsonl'].includes(name)
      )
    ).toBe(true)
    expect(issues).toEqual([
      expect.objectContaining({
        agent: 'codex',
        path: root,
        message: expect.stringContaining('safety limit')
      })
    ])
    await expect(rm(root, { recursive: true, force: true })).resolves.toBeUndefined()
    tempRoots = tempRoots.filter((candidate) => candidate !== root)
  })

  it('reports a depth overflow before opening the over-limit directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-discovery-'))
    tempRoots.push(root)
    const overLimit = join(root, 'level-one', 'level-two')
    await mkdir(overLimit, { recursive: true })
    await writeFile(join(overLimit, 'session.jsonl'), '{}\n')
    const issues: AiVaultScanIssue[] = []

    const result = await discoverFiles({
      rootDir: root,
      limit: 10,
      agent: 'codex',
      issues,
      extensions: ['.jsonl'],
      limits: { maxDepth: 1 }
    })

    expect(result.files).toEqual([])
    expect(issues).toEqual([
      expect.objectContaining({ path: root, message: expect.stringContaining('safety limit') })
    ])
  })

  it('accepts a file at the exact folder-depth capacity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-discovery-'))
    tempRoots.push(root)
    const exactLimit = join(root, 'level-one')
    await mkdir(exactLimit)
    await writeFile(join(exactLimit, 'session.jsonl'), '{}\n')
    const issues: AiVaultScanIssue[] = []

    const result = await discoverFiles({
      rootDir: root,
      limit: 10,
      agent: 'codex',
      issues,
      extensions: ['.jsonl'],
      limits: { maxDepth: 1 }
    })

    expect(result.files.map((file) => basename(file.path))).toEqual(['session.jsonl'])
    expect(issues).toEqual([])
  })
})
