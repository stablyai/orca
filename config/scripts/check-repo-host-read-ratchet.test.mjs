import { describe, expect, it } from 'vitest'

import {
  countRawRepoHostReads,
  isScannedFile,
  RESOLVER_FILES
} from './check-repo-host-read-ratchet.mjs'

describe('countRawRepoHostReads', () => {
  it('counts host decisions read off a repo row', () => {
    const text = [
      'if (repo.connectionId) {',
      'const id = sourceRepo?.connectionId ?? null',
      'repos.filter((repo) => !repo.connectionId)',
      'if (existingRepo.connectionId === targetId) {',
      'const id = repoRow!.connectionId'
    ].join('\n')
    expect(countRawRepoHostReads(text)).toBe(5)
  })

  it('ignores writes, comments, type positions and non-repo receivers', () => {
    const text = [
      'repo.connectionId = null',
      '// `!repo.connectionId` used to answer local',
      "type T = Repo['connectionId']",
      'if (pty.connectionId) {',
      'const repoConnectionId = args.connectionId',
      'if (getRepoRoutingConnectionId(repo)) {',
      'if (report.connectionId) {',
      'for (const r of repos) r.connectionId'
    ].join('\n')
    expect(countRawRepoHostReads(text)).toBe(0)
  })

  it('ignores a verbatim copy into a projected row, but not a decision beside it', () => {
    const copy = '...(repo.connectionId !== undefined ? { connectionId: repo.connectionId } : {}),'
    expect(countRawRepoHostReads(copy)).toBe(0)
    expect(countRawRepoHostReads(`${copy}\nif (repo.connectionId) {}`)).toBe(1)
    const mismatched =
      '...(repo.connectionId !== undefined ? { connectionId: sourceRepo.connectionId } : {})'
    expect(countRawRepoHostReads(mismatched)).toBe(2)
  })

  it('still counts an equality comparison, which is not an assignment', () => {
    expect(countRawRepoHostReads('if (repo.connectionId == null) {}')).toBe(1)
  })
})

describe('isScannedFile', () => {
  it('scans source, not tests, declarations or the resolvers', () => {
    expect(isScannedFile('src/main/worktree-trash.ts')).toBe(true)
    expect(isScannedFile('src/main/worktree-trash.test.ts')).toBe(false)
    expect(isScannedFile('src/shared/types.d.ts')).toBe(false)
    for (const rel of RESOLVER_FILES.keys()) {
      expect(isScannedFile(rel)).toBe(false)
    }
  })
})
