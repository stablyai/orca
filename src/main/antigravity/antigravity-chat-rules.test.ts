import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import * as reader from '../../shared/file-content/node-bounded-file-reader'
import fixture from '../acp/fixtures/antigravity-v1.4.1-options.json'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import { antigravityChatRulesMeta } from './antigravity-chat-rules'

const rulesMeta = z.object({
  antigravity: z.object({ systemPrompt: z.object({ append: z.string() }) })
})

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    realpath: vi.fn(actual.realpath),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      for (const method of ['stat', 'read', 'close'] as const) {
        vi.spyOn(handle, method)
      }
      return handle
    })
  }
})
vi.mock('../../shared/file-content/node-bounded-file-reader', async (original) => {
  const actual = await original<typeof reader>()
  return { ...actual, readNodeFileHandleWithinLimit: vi.fn(actual.readNodeFileHandleWithinLimit) }
})

async function workspace() {
  const root = await fs.mkdtemp(join(tmpdir(), 'orca-agy-rules-'))
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  await fs.mkdir(join(home, '.gemini'), { recursive: true })
  await fs.mkdir(repo)
  const read = async (cwd = repo, initialized: InitializeResponse = fixture.initialize) => {
    const meta = await antigravityChatRulesMeta({
      initialized,
      cwd,
      env: { HOME: home, USERPROFILE: home }
    })
    return meta ? rulesMeta.parse(meta).antigravity.systemPrompt.append : ''
  }
  return { root, home, repo, read }
}

it('includes global and repository ancestors once, refreshes on reopen, and excludes outer rules', async () => {
  const { root, home, repo, read } = await workspace()
  const child = join(repo, 'nested')
  await fs.mkdir(child)
  await fs.writeFile(join(repo, '.git'), 'gitdir: elsewhere')
  await fs.writeFile(join(root, 'GEMINI.md'), 'OUTSIDE')
  await fs.writeFile(join(home, '.gemini', 'GEMINI.md'), 'GLOBAL')
  await fs.writeFile(join(repo, 'GEMINI.md'), 'REPOSITORY')
  await fs.symlink(join(repo, 'GEMINI.md'), join(repo, 'AGENTS.md'))
  await fs.writeFile(join(child, 'AGENTS.md'), 'NESTED')
  expect(await read(child)).toMatch(/GLOBAL[\s\S]*REPOSITORY[\s\S]*NESTED/)
  expect((await read(child)).match(/REPOSITORY/g)).toHaveLength(1)
  expect(await read(child)).not.toContain('OUTSIDE')
  await fs.writeFile(join(child, 'AGENTS.md'), 'CHANGED')
  expect(await read(child)).toContain('CHANGED')
  expect(await read(child)).not.toContain('NESTED')
})

it('limits a folder workspace to its own rules and skips I/O without the advertised capability', async () => {
  const { root, repo, read } = await workspace()
  await fs.writeFile(join(root, 'AGENTS.md'), 'OUTSIDE')
  await fs.writeFile(join(repo, 'GEMINI.md'), 'FOLDER')
  expect(await read()).toContain('FOLDER')
  expect(await read()).not.toContain('OUTSIDE')
  vi.clearAllMocks()
  expect(await read(repo, { ...fixture.initialize, agentCapabilities: {} })).toBe('')
  expect(fs.stat).not.toHaveBeenCalled()
  expect(fs.realpath).not.toHaveBeenCalled()
})

it.each([
  { name: 'inline', global: 'GLOBAL_RULE', internal: 'INTERNAL_RULE', filler: 'FILLER' },
  {
    name: 'saturated',
    global: 'GLOBAL_RULE\n'.repeat(3_000),
    internal: 'INTERNAL_RULE\n'.repeat(3_000),
    filler: 'FILLER\n'.repeat(4_000)
  }
])('excludes outside workspace links before reads or pointers when $name', async (contents) => {
  const { root, home, repo, read } = await workspace()
  const child = join(repo, 'nested')
  await fs.mkdir(child)
  await fs.mkdir(join(repo, '.git'))
  const global = join(root, 'global-instructions')
  const outside = join(root, 'outside-instructions')
  const inside = join(repo, 'instructions')
  await fs.writeFile(global, contents.global)
  await fs.symlink(global, join(home, '.gemini', 'GEMINI.md'))
  await fs.writeFile(outside, 'OUTSIDE_PRIVATE')
  await fs.writeFile(inside, contents.internal)
  await fs.symlink(inside, join(repo, 'GEMINI.md'))
  await fs.writeFile(join(repo, 'AGENTS.md'), contents.filler)
  await fs.writeFile(join(child, 'GEMINI.md'), contents.filler)
  await fs.symlink(outside, join(child, 'AGENTS.md'))
  const append = await read(child)
  expect(append).toContain('GLOBAL_RULE')
  expect(append).toContain('INTERNAL_RULE')
  expect(append).not.toContain('OUTSIDE_PRIVATE')
  expect(append).not.toContain(outside)
})

it('uses opened-file facts to keep complete lines when a rule grows during activation', async () => {
  const { repo, read } = await workspace()
  const file = join(repo, 'GEMINI.md')
  await fs.writeFile(file, 'BEFORE\nX')
  const original = vi.mocked(fs.open).getMockImplementation()!
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    await fs.writeFile(file, `BEFORE\n${'é'.repeat(20_000)}`)
    return original(...args)
  })
  const append = await read()
  expect(append).toContain('BEFORE')
  expect(append).toContain(`Additional instructions: ${await fs.realpath(file)}`)
  expect(append).not.toContain('\uFFFD')
})

it('preserves global rules and omits workspace sources when its canonical root is unavailable', async () => {
  const { repo, home, read } = await workspace()
  await fs.writeFile(join(home, '.gemini', 'GEMINI.md'), 'GLOBAL_RULE')
  await fs.writeFile(join(repo, 'AGENTS.md'), 'WORKSPACE_RULE')
  vi.mocked(fs.realpath).mockRejectedValueOnce(new Error('Root unavailable'))
  const append = await read()
  expect(append).toContain('GLOBAL_RULE')
  expect(append).not.toContain('WORKSPACE_RULE')
  expect(append).not.toContain(repo)
})

it('keeps complete lines and file pointers for large rules, omits binary files, and honors cancellation', async () => {
  const { repo, home, read } = await workspace()
  await fs.writeFile(join(repo, 'GEMINI.md'), `COMPLETE\n${'é'.repeat(20_000)}`)
  await fs.writeFile(join(repo, 'AGENTS.md'), Buffer.from('BINARY\0DATA'))
  const append = await read()
  expect(append).toContain('COMPLETE')
  expect(append).toContain(`Additional instructions: ${await fs.realpath(join(repo, 'GEMINI.md'))}`)
  expect(append).not.toContain('é')
  expect(append).not.toContain('BINARY')
  const controller = new AbortController()
  controller.abort()
  await expect(
    antigravityChatRulesMeta({
      initialized: fixture.initialize,
      cwd: repo,
      env: { HOME: home, USERPROFILE: home },
      signal: controller.signal
    })
  ).rejects.toThrow()
})

it('omits invalid UTF-8 without expanding the inline byte budget', async () => {
  const { repo, home, read } = await workspace()
  await fs.writeFile(join(home, '.gemini', 'GEMINI.md'), 'GLOBAL\n'.repeat(4_000))
  await fs.writeFile(join(repo, 'GEMINI.md'), 'LOCAL\n'.repeat(4_000))
  await fs.writeFile(join(repo, 'AGENTS.md'), Buffer.alloc(23_800, 255))
  const append = await read()
  expect(append).toContain('GLOBAL')
  expect(append).toContain('LOCAL')
  expect(append).not.toContain('\uFFFD')
  expect(Buffer.byteLength(append)).toBeLessThanOrEqual(88_500)
})

it('stops candidate I/O when cancellation arrives during a path lookup', async () => {
  const { repo, home } = await workspace()
  await fs.writeFile(join(home, '.gemini', 'GEMINI.md'), 'GLOBAL')
  const controller = new AbortController()
  const original = vi.mocked(fs.realpath).getMockImplementation()!
  vi.mocked(fs.realpath).mockImplementationOnce(async (...args) => {
    const path = await original(...args)
    controller.abort()
    return path
  })
  vi.clearAllMocks()
  await expect(
    antigravityChatRulesMeta({
      initialized: fixture.initialize,
      cwd: repo,
      env: { HOME: home, USERPROFILE: home },
      signal: controller.signal
    })
  ).rejects.toThrow()
  expect(fs.realpath).toHaveBeenCalledTimes(1)
  expect(fs.open).not.toHaveBeenCalled()
})

it('falls back to cwd rules beyond the ancestor ceiling', async () => {
  const { repo, read } = await workspace()
  await fs.mkdir(join(repo, '.git'))
  await fs.writeFile(join(repo, 'GEMINI.md'), 'OUTSIDE_LIMIT')
  const cwd = join(repo, ...Array.from({ length: 130 }, () => 'd'))
  await fs.mkdir(cwd, { recursive: true })
  await fs.writeFile(join(cwd, 'AGENTS.md'), 'CWD_RULE')
  expect(await read(cwd)).toContain('CWD_RULE')
  expect(await read(cwd)).not.toContain('OUTSIDE_LIMIT')
})

it.each([
  [10, 'lines', 'Additional instructions:'],
  [100, 'lines', 'Additional instructions are available'],
  [10, 'unwrapped', 'Additional instructions:'],
  [100, 'unwrapped', 'Additional instructions are available'],
  [10, 'binary', 'Additional instructions:'],
  [100, 'binary', 'Additional instructions are available']
] as const)(
  'bounds activation I/O at %i ancestor directories with %s rules',
  async (count, shape, expectedPointer) => {
    const { repo, read } = await workspace()
    await fs.mkdir(join(repo, '.git'))
    let cwd = repo
    for (let index = 0; index < count; index++) {
      cwd = join(repo, ...Array.from({ length: index }, () => 'd'))
      await fs.mkdir(cwd, { recursive: true })
      const contents = {
        lines: 'RULE\n'.repeat(10_000),
        binary: Buffer.concat([Buffer.alloc(23_999, 65), Buffer.from([0]), Buffer.alloc(1000, 65)]),
        unwrapped: 'x'.repeat(25_000)
      }[shape]
      await fs.writeFile(join(cwd, 'GEMINI.md'), contents)
      await fs.writeFile(join(cwd, 'AGENTS.md'), contents)
      await fs.writeFile(join(cwd, 'unrelated.txt'), 'UNRELATED')
    }
    vi.clearAllMocks()
    const append = await read(cwd)
    // Required outputs need one marker per ancestor and at most two candidate names plus global;
    // each source needs realpath/stat/open and at most one handle stat/read/close. All reads share 80k.
    const candidates = 2 * count + 1
    let operations = [fs.stat, fs.realpath, fs.open].reduce(
      (sum, fn) => sum + vi.mocked(fn).mock.calls.length,
      0
    )
    const reads = await Promise.all(
      vi.mocked(reader.readNodeFileHandleWithinLimit).mock.results.map((result) => result.value)
    )
    for (const result of vi.mocked(fs.open).mock.results) {
      const handle = await result.value
      operations += [handle.stat, handle.read, handle.close].reduce(
        (sum, fn) => sum + vi.mocked(fn).mock.calls.length,
        0
      )
    }
    expect(operations).toBeLessThanOrEqual(count + 1 + 6 * candidates)
    expect(reads.every(({ buffer }) => buffer.length <= 24_000)).toBe(true)
    expect(reads.reduce((sum, { buffer }) => sum + buffer.length, 0)).toBeLessThanOrEqual(80_000)
    expect(Buffer.byteLength(append)).toBeLessThanOrEqual(88_500)
    expect(append).toContain(expectedPointer)
    expect(append).not.toContain('UNRELATED')
  }
)
