import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WORKSPACE_PORT_BLOCK_SIZE,
  WORKSPACE_PORT_RANGE_END,
  WORKSPACE_PORT_RANGE_START,
  buildWorkspacePortEnv
} from '../../shared/workspace-port-block'
import { WorkspacePortBlockRegistry } from './workspace-port-block-registry'

const dirs: string[] = []
function registryFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-port-blocks-'))
  dirs.push(dir)
  return join(dir, 'workspace-port-blocks.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('WorkspacePortBlockRegistry', () => {
  it('gives each workspace a 10-port block inside the range', async () => {
    const block = await new WorkspacePortBlockRegistry(registryFile()).getBlock('/repo/wt-a')
    expect(block.count).toBe(WORKSPACE_PORT_BLOCK_SIZE)
    expect(block.base).toBeGreaterThanOrEqual(WORKSPACE_PORT_RANGE_START)
    expect(block.base + block.count).toBeLessThanOrEqual(WORKSPACE_PORT_RANGE_END)
    expect((block.base - WORKSPACE_PORT_RANGE_START) % WORKSPACE_PORT_BLOCK_SIZE).toBe(0)
  })

  it('keeps a block stable across calls and restarts', async () => {
    const file = registryFile()
    const first = await new WorkspacePortBlockRegistry(file).getBlock('/repo/wt-a')
    expect(await new WorkspacePortBlockRegistry(file).getBlock('/repo/wt-a')).toEqual(first)
    expect(await new WorkspacePortBlockRegistry(file).getBlock('/repo/wt-a/')).toEqual(first)
  })

  it('never hands two workspaces the same block', async () => {
    const registry = new WorkspacePortBlockRegistry(registryFile())
    const bases = new Set<number>()
    for (let i = 0; i < 300; i++) {
      bases.add((await registry.getBlock(`/repo/wt-${i}`)).base)
    }
    expect(bases.size).toBe(300)
  })

  it('moves past a slot another workspace already holds', async () => {
    const file = registryFile()
    const registry = new WorkspacePortBlockRegistry(file)
    const a = await registry.getBlock('/repo/wt-a')
    // Pretend a second checkout hashed onto the same slot by squatting it under another key.
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        blocks: { '/other': persisted.blocks['/repo/wt-a'] }
      })
    )
    const b = await new WorkspacePortBlockRegistry(file).getBlock('/repo/wt-a')
    expect(b.base).not.toBe(a.base)
  })

  it('reclaims the oldest block once every slot is taken', async () => {
    let clock = 0
    const registry = new WorkspacePortBlockRegistry(registryFile(), () => ++clock)
    const slots =
      (WORKSPACE_PORT_RANGE_END - WORKSPACE_PORT_RANGE_START) / WORKSPACE_PORT_BLOCK_SIZE
    const oldest = await registry.getBlock('/repo/first')
    for (let i = 1; i < slots; i++) {
      await registry.getBlock(`/repo/wt-${i}`)
    }
    expect((await registry.getBlock('/repo/overflow')).base).toBe(oldest.base)
  })

  it('two processes sharing the file never hand out the same block', async () => {
    const file = registryFile()
    const a = new WorkspacePortBlockRegistry(file)
    const b = new WorkspacePortBlockRegistry(file)
    const bases = new Set<number>()
    for (let i = 0; i < 50; i++) {
      bases.add((await (i % 2 ? a : b).getBlock(`/repo/wt-${i}`)).base)
    }
    expect(bases.size).toBe(50)
    expect(await b.getBlock('/repo/wt-1')).toEqual(await a.getBlock('/repo/wt-1'))
  })

  it('ignores corrupt or out-of-range entries', async () => {
    const file = registryFile()
    writeFileSync(
      file,
      JSON.stringify({ version: 1, blocks: { '/repo/wt-a': { base: 80, allocatedAt: 1 } } })
    )
    const block = await new WorkspacePortBlockRegistry(file).getBlock('/repo/wt-a')
    expect(block.base).toBeGreaterThanOrEqual(WORKSPACE_PORT_RANGE_START)
  })

  it('exports ORCA_PORT with a CONDUCTOR_PORT alias', async () => {
    expect(buildWorkspacePortEnv({ base: 21230, count: 10 })).toEqual({
      ORCA_PORT: '21230',
      ORCA_PORT_COUNT: '10',
      CONDUCTOR_PORT: '21230'
    })
  })
})

describe('peekBlock', () => {
  it('is null until the block is allocated, then answers synchronously', async () => {
    const registry = new WorkspacePortBlockRegistry(registryFile())
    expect(registry.peekBlock('/repo/wt-a')).toBeNull()
    const block = await registry.getBlock('/repo/wt-a')
    expect(registry.peekBlock('/repo/wt-a')).toEqual(block)
  })

  it('serializes concurrent first uses into distinct blocks', async () => {
    const registry = new WorkspacePortBlockRegistry(registryFile())
    const blocks = await Promise.all(
      Array.from({ length: 20 }, (_, i) => registry.getBlock(`/repo/c-${i}`))
    )
    expect(new Set(blocks.map((block) => block.base)).size).toBe(20)
  })
})
