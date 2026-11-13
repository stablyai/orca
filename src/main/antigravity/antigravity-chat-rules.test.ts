import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
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
    open: vi.fn(actual.open)
  }
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
