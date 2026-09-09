import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  canonicalOfficeDocumentPath,
  OfficeDocumentPathError,
  officeSessionKey
} from './office-document-path'
import { NATIVE_OFFICECLI_LANE } from './officecli-lane'

let directory = ''

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-office-path-'))
  await writeFile(join(directory, 'deck.pptx'), 'x')
})

afterAll(() => rm(directory, { recursive: true, force: true }))

describe('office document path canonicalisation', () => {
  it('resolves a symlink to the file the host will actually watch', async () => {
    // Why it matters here and not only for tidiness: `officecli unwatch` matches the literal
    // spelling `watch` was given, so two spellings of one document cannot stop each other.
    const link = join(directory, 'link.pptx')
    await symlink(join(directory, 'deck.pptx'), link)
    const canonical = await canonicalOfficeDocumentPath(link, NATIVE_OFFICECLI_LANE)
    const direct = await canonicalOfficeDocumentPath(
      join(directory, 'deck.pptx'),
      NATIVE_OFFICECLI_LANE
    )
    expect(canonical).toBe(direct)
  })

  it('collapses a redundant spelling of the same path', async () => {
    const noisy = join(directory, '.', 'sub', '..', 'deck.pptx')
    await expect(canonicalOfficeDocumentPath(noisy, NATIVE_OFFICECLI_LANE)).resolves.toBe(
      await canonicalOfficeDocumentPath(join(directory, 'deck.pptx'), NATIVE_OFFICECLI_LANE)
    )
  })

  it('refuses a path it cannot address instead of passing it to a spawn', async () => {
    for (const bad of ['', '   ', 'relative/deck.pptx', join(directory, 'absent.pptx')]) {
      await expect(canonicalOfficeDocumentPath(bad, NATIVE_OFFICECLI_LANE)).rejects.toBeInstanceOf(
        OfficeDocumentPathError
      )
    }
  })

  it('keys a session by host and path together', () => {
    // One document on two hosts is two sessions; the same document twice is one.
    expect(officeSessionKey('local', '/w/a.pptx')).toBe(officeSessionKey('local', '/w/a.pptx'))
    expect(officeSessionKey('local', '/w/a.pptx')).not.toBe(
      officeSessionKey('ssh:build-box', '/w/a.pptx')
    )
  })
})
