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
  it('gives each workspace a 10-port block inside the range', () => {
    const block = new WorkspacePortBlockRegistry(registryFile()).getBlock('/repo/wt-a')
    expect(block.count).toBe(WORKSPACE_PORT_BLOCK_SIZE)
    expect(block.base).toBeGreaterThanOrEqual(WORKSPACE_PORT_RANGE_START)
    expect(block.base + block.count).toBeLessThanOrEqual(WORKSPACE_PORT_RANGE_END)
    expect((block.base - WORKSPACE_PORT_RANGE_START) % WORKSPACE_PORT_BLOCK_SIZE).toBe(0)
  })

  it('keeps a block stable across calls and restarts', () => {
    const file = registryFile()
    const first = new WorkspacePortBlockRegistry(file).getBlock('/repo/wt-a')
    expect(new WorkspacePortBlockRegistry(file).getBlock('/repo/wt-a')).toEqual(first)
    expect(new WorkspacePortBlockRegistry(file).getBlock('/repo/wt-a/')).toEqual(first)
  })

  it('never hands two workspaces the same block', () => {
    const registry = new WorkspacePortBlockRegistry(registryFile())
    const bases = new Set<number>()
    for (let i = 0; i < 300; i++) {
      bases.add(registry.getBlock(`/repo/wt-${i}`).base)
    }
    expect(bases.size).toBe(300)
  })

  it('moves past a slot another workspace already holds', () => {
    const file = registryFile()
    const registry = new WorkspacePortBlockRegistry(file)
    const a = registry.getBlock('/repo/wt-a')
    // Pretend a second checkout hashed onto the same slot by squatting it under another key.
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        blocks: { '/other': persisted.blocks['/repo/wt-a'] }
      })
    )
    const b = new WorkspacePortBlockRegistry(file).getBlock('/repo/wt-a')
    expect(b.base).not.toBe(a.base)
  })

  it('reclaims the oldest block once every slot is taken', () => {
    let clock = 0
    const registry = new WorkspacePortBlockRegistry(registryFile(), () => ++clock)
    const slots =
      (WORKSPACE_PORT_RANGE_END - WORKSPACE_PORT_RANGE_START) / WORKSPACE_PORT_BLOCK_SIZE
    const oldest = registry.getBlock('/repo/first')
    for (let i = 1; i < slots; i++) {
      registry.getBlock(`/repo/wt-${i}`)
    }
    expect(registry.getBlock('/repo/overflow').base).toBe(oldest.base)
  })

  it('two processes sharing the file never hand out the same block', () => {
    const file = registryFile()
    const a = new WorkspacePortBlockRegistry(file)
    const b = new WorkspacePortBlockRegistry(file)
    const bases = new Set<number>()
    for (let i = 0; i < 50; i++) {
      bases.add((i % 2 ? a : b).getBlock(`/repo/wt-${i}`).base)
    }
    expect(bases.size).toBe(50)
    expect(b.getBlock('/repo/wt-1')).toEqual(a.getBlock('/repo/wt-1'))
  })

  it('ignores corrupt or out-of-range entries', () => {
    const file = registryFile()
    writeFileSync(
      file,
      JSON.stringify({ version: 1, blocks: { '/repo/wt-a': { base: 80, allocatedAt: 1 } } })
    )
    const block = new WorkspacePortBlockRegistry(file).getBlock('/repo/wt-a')
    expect(block.base).toBeGreaterThanOrEqual(WORKSPACE_PORT_RANGE_START)
  })

  it('exports ORCA_PORT with a CONDUCTOR_PORT alias', () => {
    expect(buildWorkspacePortEnv({ base: 21230, count: 10 })).toEqual({
      ORCA_PORT: '21230',
      ORCA_PORT_COUNT: '10',
      CONDUCTOR_PORT: '21230'
    })
  })
})
