import { describe, expect, it, vi } from 'vitest'
import { buildMobileDiffReviewQueue } from '../session/mobile-diff-review-queue'
import { buildMobileBranchCompareSection } from './mobile-branch-compare'
import { buildMobileSourceControlSections, type MobileGitStatusEntry } from './mobile-git-status'

const paths = [
  'file10.ts',
  'file2.ts',
  'file02.ts',
  'café.ts',
  'cafe\u0301.ts',
  'Z.ts',
  'a.ts',
  'Ä.ts',
  'İ.ts',
  'package-lock.json'
]
const entries = paths.flatMap((path, index) =>
  (['staged', 'untracked', 'unstaged'] as const).map((area) => ({
    path,
    oldPath: `old-${index}`,
    area,
    status: 'modified' as const,
    conflictStatus:
      index % 3 === 0
        ? ('unresolved' as const)
        : index % 3 === 1
          ? ('resolved_locally' as const)
          : undefined
  }))
)
const reviewInput = {
  worktreeId: 'workspace',
  statusEntries: entries,
  branchEntries: entries.filter((entry) => entry.area === 'staged'),
  comments: [],
  reviewState: { version: 1 as const, files: {} }
}
const comparePath = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
const conflictRank = (entry: MobileGitStatusEntry) =>
  entry.conflictStatus === 'unresolved' ? 0 : entry.conflictStatus === 'resolved_locally' ? 1 : 2

describe('mobile path sort collation', () => {
  it('preserves numeric ties, Unicode equivalence, conflict rank, and section order', () => {
    const original = [...entries]
    const sections = buildMobileSourceControlSections(entries)
    expect(sections.map((section) => section.area)).toEqual(['unstaged', 'untracked', 'staged'])
    for (const section of sections) {
      expect(section.data).toEqual(
        entries
          .filter((entry) => entry.area === section.area)
          .sort((a, b) => conflictRank(a) - conflictRank(b) || comparePath(a.path, b.path))
      )
    }
    expect(buildMobileBranchCompareSection(entries)?.data).toEqual(
      [...entries].sort((a, b) => comparePath(a.path, b.path))
    )
    expect(entries).toEqual(original)
  })

  it('preserves review scope and generated-file precedence before numeric path order', () => {
    const unsorted = [
      ...entries.flatMap((entry) =>
        buildMobileDiffReviewQueue({ ...reviewInput, statusEntries: [entry], branchEntries: [] })
      ),
      ...reviewInput.branchEntries.flatMap((entry) =>
        buildMobileDiffReviewQueue({ ...reviewInput, statusEntries: [], branchEntries: [entry] })
      )
    ]
    const scopeRank = { unstaged: 0, staged: 1, branch: 2 }
    const expected = unsorted.sort(
      (a, b) =>
        scopeRank[a.scope] - scopeRank[b.scope] ||
        Number(a.isGeneratedOrLockFile) - Number(b.isGeneratedOrLockFile) ||
        comparePath(a.filePath, b.filePath)
    )
    expect(buildMobileDiffReviewQueue(reviewInput)).toEqual(expected)
  })

  it('resolves the current locale once per populated sort and never per comparison', () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
    const NativeCollator = Intl.Collator
    const collator = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
      return new NativeCollator(locales, options)
    })
    try {
      for (let call = 0; call < 2; call++) {
        buildMobileSourceControlSections(entries)
        buildMobileBranchCompareSection(entries)
        buildMobileDiffReviewQueue(reviewInput)
      }
      expect(localeCompare).not.toHaveBeenCalled()
      expect(collator).toHaveBeenCalledTimes(6)
      expect(collator).toHaveBeenCalledWith(undefined, { numeric: true })
    } finally {
      localeCompare.mockRestore()
      collator.mockRestore()
    }
  })

  it('does not initialize collation for empty or singleton collections', () => {
    const collator = vi.spyOn(Intl, 'Collator')
    try {
      for (const rows of [[], [entries[0]]]) {
        buildMobileSourceControlSections(rows)
        buildMobileBranchCompareSection(rows)
        buildMobileDiffReviewQueue({ ...reviewInput, statusEntries: rows, branchEntries: [] })
      }
      expect(collator).not.toHaveBeenCalled()
    } finally {
      collator.mockRestore()
    }
  })
})
