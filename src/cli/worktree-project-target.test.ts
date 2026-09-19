/**
 * STA-6080: `--host runtime:<id>` silently bound to a `local`-stamped setup.
 *
 * On the affected host every setup was stamped `local` and the project had six ready ones, so the
 * fallback matched and selection took whichever was first — aiming worktree creation at an
 * unrelated checkout. Ambiguity must be refused, not guessed.
 */

import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../shared/project-types'
import { resolveProjectCreateTarget } from './worktree-project-target'

function readySetup(overrides: Partial<ProjectHostSetup>): ProjectHostSetup {
  return {
    id: 'setup-id',
    projectId: 'github:stablyai/orca',
    hostId: 'local',
    repoId: 'repo-id',
    path: '/repo',
    displayName: 'orca',
    kind: 'git',
    setupState: 'ready',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as ProjectHostSetup
}

function clientReturning(setups: ProjectHostSetup[]): never {
  return {
    call: async (method: string) => {
      if (method !== 'projectHostSetup.list') {
        throw new Error(`unexpected method: ${method}`)
      }
      return { result: { setups } }
    }
  } as never
}

const flagsFor = (host: string): Map<string, string | boolean> =>
  new Map<string, string | boolean>([
    ['project', 'github:stablyai/orca'],
    ['host', host]
  ])

describe('resolveProjectCreateTarget host selection', () => {
  it.each([
    ['C0', 'setup\n', 'setup\\u000a'],
    ['C1', 'setup\u009b', 'setup\\u009b'],
    ['zero-width', 'setup\u200b', 'setup\\u200b'],
    ['line separator', 'setup\u2028', 'setup\\u2028'],
    ['bidi override', 'setup\u202e', 'setup\\u202e'],
    ['word joiner', 'setup\u2060', 'setup\\u2060'],
    ['BOM', 'setup\ufeff', 'setup\\ufeff'],
    ['backslash', 'setup\\value', 'setup\\\\value']
  ])('resolves an %s id copied from the ambiguity diagnostic', async (_name, id, escapedId) => {
    const client = clientReturning([readySetup({ id, repoId: 'repo-selected' })])
    const flags = new Map<string, string | boolean>([['project-host-setup', escapedId]])

    await expect(resolveProjectCreateTarget(flags, client)).resolves.toEqual(
      expect.objectContaining({
        repoSelector: 'id:repo-selected',
        setup: expect.objectContaining({ id })
      })
    )
  })

  it('preserves raw id matching when it collides with another id display', async () => {
    const rawId = 'setup\\u000a'
    const client = clientReturning([
      readySetup({ id: rawId, repoId: 'repo-raw' }),
      readySetup({ id: 'setup\n', repoId: 'repo-escaped' })
    ])
    const flags = new Map<string, string | boolean>([['project-host-setup', rawId]])

    await expect(resolveProjectCreateTarget(flags, client)).resolves.toEqual(
      expect.objectContaining({ repoSelector: 'id:repo-raw' })
    )
  })

  it('refuses, and names the candidates, when several setups could match', async () => {
    const client = clientReturning([
      readySetup({ id: 'a', repoId: 'repo-a', path: 'C:\\Users\\neil\\orca\\orca' }),
      readySetup({ id: 'b', repoId: 'repo-b', path: 'C:\\orca\\orca' })
    ])

    const failure = resolveProjectCreateTarget(flagsFor('runtime:env-1'), client)

    await expect(failure).rejects.toThrow(/2 ready setups/)
    // The whole point: the user is shown which checkouts were in play.
    // Backslashes are doubled by the escaping — the cost of an injective rendering.
    await expect(failure).rejects.toThrow(/C:\\\\Users\\\\neil\\\\orca/)
  })

  it('resolves when exactly one setup could match', async () => {
    const client = clientReturning([readySetup({ id: 'only', repoId: 'repo-only' })])

    await expect(resolveProjectCreateTarget(flagsFor('runtime:env-1'), client)).resolves.toEqual(
      expect.objectContaining({ repoSelector: 'id:repo-only' })
    )
  })

  it('prefers an exact host match over local-stamped candidates', async () => {
    // An exact match is unambiguous even when local-stamped rows also exist, so it must not
    // be dragged into the ambiguity check.
    const client = clientReturning([
      readySetup({ id: 'local-a', repoId: 'repo-local-a' }),
      readySetup({ id: 'local-b', repoId: 'repo-local-b' }),
      readySetup({ id: 'exact', repoId: 'repo-exact', hostId: 'runtime:env-1' })
    ])

    await expect(resolveProjectCreateTarget(flagsFor('runtime:env-1'), client)).resolves.toEqual(
      expect.objectContaining({ repoSelector: 'id:repo-exact' })
    )
  })

  it('refuses an ambiguous project even with no --host, and names the setup ids', async () => {
    // Without --host the old code returned candidates[0]; ordering is persistence order, not a
    // user choice. On the affected host this project has six ready setups.
    const client = clientReturning([
      readySetup({ id: 'setup-a', repoId: 'repo-a', path: 'C:\\Users\\neil\\orca\\orca' }),
      readySetup({ id: 'setup-b', repoId: 'repo-b', path: 'C:\\orca\\orca' })
    ])
    const flags = new Map<string, string | boolean>([['project', 'github:stablyai/orca']])

    const failure = resolveProjectCreateTarget(flags, client)

    await expect(failure).rejects.toThrow(/2 ready setups/)
    // The remedy names --project-host-setup <id>, so the id has to be shown.
    await expect(failure).rejects.toThrow(/setup-a/)
  })

  it('still resolves a single setup when no --host is given', async () => {
    const client = clientReturning([readySetup({ id: 'only', repoId: 'repo-only' })])
    const flags = new Map<string, string | boolean>([['project', 'github:stablyai/orca']])

    await expect(resolveProjectCreateTarget(flags, client)).resolves.toEqual(
      expect.objectContaining({ repoSelector: 'id:repo-only' })
    )
  })

  it('neutralises control characters in setup metadata before printing', async () => {
    // Paths are persisted metadata and may contain newlines or ANSI; this message goes straight
    // to a terminal, so an unescaped value could forge a line.
    const client = clientReturning([
      readySetup({ id: 'setup-a', repoId: 'repo-a', path: '/repo\n  forged  (fake setup)' }),
      readySetup({ id: 'setup-b', repoId: 'repo-b', path: '/other' })
    ])
    const flags = new Map<string, string | boolean>([['project', 'github:stablyai/orca']])

    await expect(resolveProjectCreateTarget(flags, client)).rejects.toThrow(/\/repo\\u000a  forged/)
  })

  it('escapes C1, bidi and line-separator forgeries, keeping distinct ids distinct', async () => {
    const client = clientReturning([
      readySetup({ id: 'a\u009b31m', repoId: 'repo-a', path: '/one\u2028forged' }),
      readySetup({ id: 'a\u202e31m', repoId: 'repo-b', path: '/two' })
    ])
    const flags = new Map<string, string | boolean>([['project', 'github:stablyai/orca']])
    const failure = resolveProjectCreateTarget(flags, client)

    await expect(failure).rejects.toThrow(/a\\u009b31m/)
    await expect(failure).rejects.toThrow(/one\\u2028forged/)
    // Distinct ids must not collapse onto the same rendering.
    await expect(failure).rejects.toThrow(/a\\u202e31m/)
  })

  it('escapes backslashes so the rendering is injective and ids copy back', async () => {
    // Without escaping backslash first, a literal "\\u000a" and a real newline render the same,
    // and the id the error tells the user to pass becomes ambiguous.
    const client = clientReturning([
      readySetup({ id: 'lit\\u000a', repoId: 'repo-a', path: '/one' }),
      readySetup({ id: 'real\n', repoId: 'repo-b', path: '/two' })
    ])
    const flags = new Map<string, string | boolean>([['project', 'github:stablyai/orca']])
    const failure = resolveProjectCreateTarget(flags, client)

    await expect(failure).rejects.toThrow(/lit\\\\u000a/)
    await expect(failure).rejects.toThrow(/real\\u000a/)
  })

  it('escapes zero-width and directionality characters', async () => {
    const client = clientReturning([
      readySetup({ id: 'a\u200b', repoId: 'repo-a', path: '/one\ufeff' }),
      readySetup({ id: 'b', repoId: 'repo-b', path: '/two' })
    ])
    const flags = new Map<string, string | boolean>([['project', 'github:stablyai/orca']])
    const failure = resolveProjectCreateTarget(flags, client)

    await expect(failure).rejects.toThrow(/a\\u200b/)
    await expect(failure).rejects.toThrow(/one\\ufeff/)
  })
})
