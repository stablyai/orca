import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import type { MethodHandler, RequestContext } from './dispatcher'

const mocks = vi.hoisted(() => ({ homedir: vi.fn(() => '/nonexistent-home') }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => mocks.homedir() }
})

import { SkillDiscoveryHandler } from './skill-discovery-handler'

function createHandler(): MethodHandler {
  const handlers = new Map<string, MethodHandler>()
  new SkillDiscoveryHandler({
    onRequest: (method: string, handler: MethodHandler): void => {
      handlers.set(method, handler)
    }
  } as never)
  const handler = handlers.get('skills.discover')
  if (!handler) {
    throw new Error('skills.discover handler not registered')
  }
  return handler
}

function requestContext(signal?: AbortSignal): RequestContext {
  return { clientId: 1, isStale: () => false, signal }
}

describe('SkillDiscoveryHandler', () => {
  beforeEach(() => {
    mocks.homedir.mockReturnValue('/nonexistent-home')
  })

  it('discovers remote home and repository skills from the relay host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-skills-'))
    const home = join(root, 'home')
    const repo = join(root, 'repo')
    await mkdir(join(home, '.codex', 'skills', 'review'), { recursive: true })
    await mkdir(join(repo, '.agents', 'skills', 'docs'), { recursive: true })
    await mkdir(join(repo, '.claude', 'skills', 'notes'), { recursive: true })
    await writeFile(
      join(home, '.codex', 'skills', 'review', 'SKILL.md'),
      ['---', 'name: code-review', 'description: Review changes.', '---', ''].join('\n')
    )
    await writeFile(join(repo, '.agents', 'skills', 'docs', 'SKILL.md'), '# Docs\n')
    await writeFile(join(repo, '.claude', 'skills', 'notes', 'SKILL.md'), '# Notes\n')
    mocks.homedir.mockReturnValue(home)

    const result = (await createHandler()({ cwd: repo }, requestContext())) as {
      skills: { name: string; providers: string[] }[]
      sources: { exists: boolean }[]
    }

    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      'Docs',
      'Notes',
      'code-review'
    ])
    expect(result.skills.find((skill) => skill.name === 'Docs')?.providers).toEqual([
      'agent-skills'
    ])
    expect(result.skills.find((skill) => skill.name === 'Notes')?.providers).toEqual(['claude'])
    // Missing roots are reported exactly as local targeted discovery reports them.
    expect(result.sources.some((source) => !source.exists)).toBe(true)
  })

  it('rejects a missing, empty, or oversized cwd', async () => {
    const handler = createHandler()
    await expect(handler({}, requestContext())).rejects.toThrow('Invalid skill discovery cwd')
    await expect(handler({ cwd: '   ' }, requestContext())).rejects.toThrow(
      'Invalid skill discovery cwd'
    )
    await expect(handler({ cwd: 'x'.repeat(5000) }, requestContext())).rejects.toThrow(
      'Invalid skill discovery cwd'
    )
  })

  it('rejects a cancelled request instead of publishing an empty success', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      createHandler()({ cwd: '/tmp/anywhere' }, requestContext(controller.signal))
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('never includes full SKILL.md contents in the response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-skills-'))
    const repo = join(root, 'repo')
    await mkdir(join(repo, '.agents', 'skills', 'docs'), { recursive: true })
    // Name/description metadata may cross; body text past them must not.
    const body = [
      '---',
      'name: docs',
      'description: Write docs.',
      '---',
      '',
      'SECRET-BODY-MARKER should never cross the relay boundary.'
    ].join('\n')
    await writeFile(join(repo, '.agents', 'skills', 'docs', 'SKILL.md'), body)

    const result = await createHandler()({ cwd: repo }, requestContext())

    expect(JSON.stringify(result)).not.toContain('SECRET-BODY-MARKER')
  })
})
