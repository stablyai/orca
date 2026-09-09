/**
 * The workspace boundary every office method resolves through.
 *
 * Every neighbouring runtime `files.*` method is `(worktree, relativePath)` and resolves on the
 * host; office used to be the one surface taking a bare absolute path. These pin the boundary that
 * closed that gap, including the case a lexical check cannot see — a symlink inside the workspace
 * pointing out of it.
 */
import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  OfficeDocumentOutsideWorkspaceError,
  OfficeDocumentPathError,
  resolveOfficeDocumentTarget
} from './office-document-path'
import { NATIVE_OFFICECLI_LANE } from './officecli-lane'
import { isValidOfficeRelativePath, joinOfficeRelativePath } from '../../shared/office-preview-rpc'

let root = ''
let outside = ''

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'orca-office-boundary-'))
  root = join(base, 'workspace')
  outside = join(base, 'elsewhere')
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, 'docs', 'report.docx'), 'x')
  await writeFile(join(outside, 'secret.docx'), 'x')
})

afterAll(() => rm(join(root, '..'), { recursive: true, force: true }))

describe('office workspace boundary', () => {
  it('resolves a document inside the workspace', async () => {
    await expect(
      resolveOfficeDocumentTarget(root, 'docs/report.docx', NATIVE_OFFICECLI_LANE)
    ).resolves.toContain('report.docx')
  })

  it('refuses a relative path that climbs out of the workspace', async () => {
    await expect(
      resolveOfficeDocumentTarget(root, '../elsewhere/secret.docx', NATIVE_OFFICECLI_LANE)
    ).rejects.toBeInstanceOf(OfficeDocumentOutsideWorkspaceError)
  })

  it('refuses a symlink inside the workspace that points outside it', async () => {
    // The case a lexical join cannot catch, and the reason the containment test runs *after*
    // canonicalisation rather than on the joined string.
    await symlink(join(outside, 'secret.docx'), join(root, 'docs', 'link.docx'))
    await expect(
      resolveOfficeDocumentTarget(root, 'docs/link.docx', NATIVE_OFFICECLI_LANE)
    ).rejects.toBeInstanceOf(OfficeDocumentOutsideWorkspaceError)
  })

  it('refuses an absolute path smuggled in as the relative half', async () => {
    for (const smuggled of [
      join(outside, 'secret.docx'),
      '/etc/passwd',
      'C:\\\\Windows\\\\x.docx'
    ]) {
      expect(isValidOfficeRelativePath(smuggled)).toBe(false)
      expect(joinOfficeRelativePath(root, smuggled)).toBeNull()
    }
  })

  it('refuses a document that does not exist rather than guessing', async () => {
    await expect(
      resolveOfficeDocumentTarget(root, 'docs/absent.docx', NATIVE_OFFICECLI_LANE)
    ).rejects.toBeInstanceOf(OfficeDocumentPathError)
  })

  it('joins without inventing a separator the host cannot read', () => {
    expect(joinOfficeRelativePath('/w/repo', 'a/b.docx')).toBe('/w/repo/a/b.docx')
    expect(joinOfficeRelativePath('/w/repo/', 'a/b.docx')).toBe('/w/repo/a/b.docx')
    expect(joinOfficeRelativePath('C:\\repo', 'a\\b.docx')).toBe('C:\\repo\\a\\b.docx')
    expect(joinOfficeRelativePath('\\\\wsl$\\Ubuntu\\home', 'a.docx')).toBe(
      '\\\\wsl$\\Ubuntu\\home\\a.docx'
    )
  })
})
