import type { Dirent } from 'node:fs'
import { opendir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  isSkillScanAttentionReason,
  isTruncatingSkillScanReason,
  type SkillFreshnessScanIssueReason
} from '../../shared/skill-freshness'
import { declaredPluginSkillRoots, isWithinRoot } from './skill-plugin-manifest-roots'

export const MAXIMUM_PLUGIN_SCAN_DEPTH = 9
const MAXIMUM_DECLARED_SKILL_SCAN_DEPTH = 6
// Why: a skill package's own payload (templates, fixtures, sample apps) is not a skill
// tree, and it is what drives ordinary caches past the depth and entry bounds. Descend
// far enough to still find a skill grouped under a package, then stop.
//
// Changing this is a real tradeoff, not a tuning knob. Raising it spends the entry budget
// on vendor payload — the cost that made ordinary caches collapse to a poison sentinel and
// pin every skill amber (#10865). Lowering it, or leaving it, means a skill buried deeper
// is never seen; that costs only a Details row, because a plugin-cache placement is not
// convergeable by any update command. So the failure direction here is silence, which is
// the safe one. Both sides of the boundary are pinned by test (#11454) — if you move this,
// that test will fail, and it is meant to.
const MAXIMUM_NESTED_SKILL_DEPTH = 2
// Why: sized against a real multi-vendor cache, which reads ~7k entries once payload is
// pruned. The bound still exists to stop a hostile or runaway tree; it is not a budget
// ordinary installs are meant to exhaust.
export const MAXIMUM_PLUGIN_SCAN_ENTRIES = 16_384
export const MAXIMUM_PLUGIN_SKILL_CANDIDATES = 64
export const MAXIMUM_PLUGIN_SCAN_ISSUES = 16
// Why: an attention issue outranks the display budget, so nothing else bounds how many a
// pathological tree can pin in memory. One is all the badge needs to be truthful; a few
// more give the dialog enough distinct paths to read as a pattern, and 'issue-limit' still
// says there are others.
export const MAXIMUM_PLUGIN_SCAN_ATTENTION_ISSUES = 4
const SKILL_FILE_NAME = 'SKILL.md'

export type KnownPluginSkillCandidate = {
  name: string
  path: string
}

export type KnownPluginSkillScanIssue = {
  path: string
  reason: SkillFreshnessScanIssueReason
  errorCode: string | null
}

export type KnownPluginSkillScan = {
  candidates: KnownPluginSkillCandidate[]
  issues: KnownPluginSkillScanIssue[]
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}

// Why: overriding a bound is how its truncation path stays executable — reaching the real
// entry budget costs a 16k-dirent fixture per case, and the declared-root guard below it
// needs the running count parked just under that budget. Production passes neither.
export type PluginSkillScanBounds = {
  maximumCandidates?: number
  maximumEntries?: number
}

export async function scanKnownPluginSkillCandidates(
  rootPath: string,
  knownNames: ReadonlySet<string>,
  bounds: PluginSkillScanBounds = {}
): Promise<KnownPluginSkillScan> {
  const maximumCandidates = bounds.maximumCandidates ?? MAXIMUM_PLUGIN_SKILL_CANDIDATES
  const maximumEntries = bounds.maximumEntries ?? MAXIMUM_PLUGIN_SCAN_ENTRIES
  const candidates: KnownPluginSkillCandidate[] = []
  const issues: KnownPluginSkillScanIssue[] = []
  const issueKeys = new Set<string>()
  const visited = new Set<string>()
  let attentionIssueCount = 0
  let resolvedRoot: string | null = null
  let entryCount = 0
  let limitReached = false

  // Why: an issue that explains a candidate is not optional. Dropping it for budget
  // leaves the badge reacting to a placement the dialog can't account for, which is
  // the split this change exists to remove — so those are charged past the bound,
  // itself bounded by the candidate cap.
  function recordIssue(
    path: string,
    reason: KnownPluginSkillScanIssue['reason'],
    code: string | null = null,
    explainsCandidate = false
  ): void {
    const key = `${path}\0${reason}\0${code ?? ''}`
    if (issueKeys.has(key)) {
      return
    }
    // Why: an attention issue is the only thing that can turn the headline off "all up to
    // date", so evicting one for display budget makes Orca report all-clear over a read
    // failure. Reserving a few keeps that unbounded on a tree full of unreadable folders.
    const attention =
      isSkillScanAttentionReason(reason) &&
      attentionIssueCount < MAXIMUM_PLUGIN_SCAN_ATTENTION_ISSUES
    // Why: the bound that ended the walk is the one issue the dialog cannot do without
    // — dropping it for display budget is what lets a truncated scan report all-clear.
    const required = explainsCandidate || attention || isTruncatingSkillScanReason(reason)
    // Why: this budget bounds what the dialog lists, not how far the scan reaches.
    // Ending the walk here would truncate coverage over a display limit — and since
    // Orca's own bounds no longer raise attention, it would do so silently.
    if (!required && issues.length >= MAXIMUM_PLUGIN_SCAN_ISSUES) {
      if (!issues.some((issue) => issue.reason === 'issue-limit')) {
        issues.push({
          path: rootPath,
          reason: 'issue-limit',
          errorCode: null
        })
      }
      return
    }
    issueKeys.add(key)
    if (isSkillScanAttentionReason(reason)) {
      attentionIssueCount += 1
    }
    issues.push({ path, reason, errorCode: code })
  }

  function recordCandidate(name: string, path: string): void {
    if (candidates.length >= maximumCandidates) {
      limitReached = true
      recordIssue(rootPath, 'candidate-limit')
      return
    }
    candidates.push({ name, path })
  }

  // Why: a directory only proves it is a skill by carrying SKILL.md. Matching a known
  // name alone would promote any same-named plugin or vendor folder into an installation
  // Orca never verified.
  async function hasSkillFile(
    directory: string,
    entries: readonly Dirent[],
    resolvedDirectory: string
  ): Promise<boolean> {
    const skillFile = entries.find((entry) => entry.name === SKILL_FILE_NAME)
    if (!skillFile) {
      return false
    }
    if (!skillFile.isSymbolicLink()) {
      return skillFile.isFile()
    }
    try {
      const skillFilePath = join(directory, skillFile.name)
      const resolvedSkillFile = await realpath(skillFilePath)
      if (!isWithinRoot(resolvedRoot ?? resolvedDirectory, resolvedSkillFile)) {
        recordIssue(skillFilePath, 'outside-root')
        return false
      }
      return (await stat(resolvedSkillFile)).isFile()
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        recordIssue(join(directory, skillFile.name), 'io-error', errorCode(error))
      }
      return false
    }
  }

  async function visit(
    directory: string,
    depth: number,
    withinDeclaredSkillRoot = false,
    payloadDepth: number | null = null
  ): Promise<void> {
    if (limitReached) {
      return
    }
    const maximumDepth = withinDeclaredSkillRoot
      ? MAXIMUM_DECLARED_SKILL_SCAN_DEPTH
      : MAXIMUM_PLUGIN_SCAN_DEPTH
    if (depth > maximumDepth) {
      recordIssue(directory, 'depth-limit')
      return
    }
    let resolved: string
    try {
      resolved = await realpath(directory)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        recordIssue(directory, 'io-error', errorCode(error))
      }
      return
    }
    if (resolvedRoot === null) {
      resolvedRoot = resolved
    } else if (!isWithinRoot(resolvedRoot, resolved)) {
      recordIssue(directory, 'outside-root')
      return
    }
    if (visited.has(resolved)) {
      return
    }
    visited.add(resolved)

    let handle: Awaited<ReturnType<typeof opendir>>
    try {
      handle = await opendir(resolved)
    } catch (error) {
      recordIssue(directory, 'io-error', errorCode(error))
      return
    }
    const entries: Dirent[] = []
    try {
      for (;;) {
        const entry = await handle.read()
        if (!entry) {
          break
        }
        entryCount += 1
        if (entryCount > maximumEntries) {
          limitReached = true
          recordIssue(rootPath, 'entry-limit')
          break
        }
        entries.push(entry)
      }
    } catch (error) {
      recordIssue(directory, 'io-error', errorCode(error))
    } finally {
      await handle.close().catch(() => undefined)
    }

    const isSkillPackage = await hasSkillFile(directory, entries, resolved)
    if (isSkillPackage) {
      const name = basename(directory)
      if (knownNames.has(name)) {
        recordCandidate(name, directory)
      }
    }

    // Why: pruning payload is a topology decision, not a coverage failure, so it stays
    // silent — recording it would put Orca's own traversal rules in the user's dialog.
    const nextPayloadDepth = isSkillPackage ? 0 : payloadDepth === null ? null : payloadDepth + 1
    if (nextPayloadDepth !== null && nextPayloadDepth > MAXIMUM_NESTED_SKILL_DEPTH) {
      return
    }

    const skillRoots = await declaredPluginSkillRoots(directory, entries, resolvedRoot, recordIssue)
    if (limitReached) {
      return
    }
    if (skillRoots) {
      const skillRootDepth = withinDeclaredSkillRoot ? depth + 1 : 0
      for (const skillRoot of skillRoots.sort()) {
        entryCount += 1
        if (entryCount > maximumEntries) {
          limitReached = true
          recordIssue(rootPath, 'entry-limit')
          return
        }
        await visit(skillRoot, skillRootDepth, true)
      }
      return
    }

    entries.sort((left, right) => (left.name === right.name ? 0 : left.name < right.name ? -1 : 1))
    for (const entry of entries) {
      if (limitReached) {
        return
      }
      if (entry.name === 'node_modules') {
        continue
      }
      const entryPath = join(directory, entry.name)
      let directoryEntry = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        try {
          directoryEntry = (await stat(entryPath)).isDirectory()
          if (directoryEntry) {
            const resolvedEntry = await realpath(entryPath)
            if (resolvedRoot !== null && !isWithinRoot(resolvedRoot, resolvedEntry)) {
              recordIssue(entryPath, 'outside-root')
              continue
            }
          }
        } catch (error) {
          const code = errorCode(error)
          // Why: inside a declared skill root the plugin itself claims this name is a
          // skill, so an uninspectable link stays fail-closed. Outside one there is no
          // such claim and no SKILL.md to read, so inventing a copy would be a guess.
          const claimedSkill = withinDeclaredSkillRoot && knownNames.has(entry.name)
          // Why: a fail-closed candidate reads as inaccessible and raises attention, so
          // the path has to be named even when it is merely absent.
          if (claimedSkill) {
            recordIssue(entryPath, 'io-error', code, true)
            recordCandidate(entry.name, entryPath)
          } else if (code !== 'ENOENT') {
            recordIssue(entryPath, 'io-error', code)
          }
          continue
        }
      }
      if (!directoryEntry) {
        continue
      }
      await visit(entryPath, depth + 1, withinDeclaredSkillRoot, nextPayloadDepth)
    }
  }

  await visit(rootPath, 0)
  return { candidates, issues }
}
