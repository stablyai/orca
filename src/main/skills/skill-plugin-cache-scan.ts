import type { Dirent } from 'node:fs'
import { opendir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SkillFreshnessScanIssueReason } from '../../shared/skill-freshness'
import { declaredPluginSkillRoots, isWithinRoot } from './skill-plugin-manifest-roots'

const MAXIMUM_PLUGIN_SCAN_DEPTH = 9
const MAXIMUM_DECLARED_SKILL_SCAN_DEPTH = 6
const MAXIMUM_PLUGIN_SCAN_ENTRIES = 4_096
export const MAXIMUM_PLUGIN_SKILL_CANDIDATES = 64
const MAXIMUM_PLUGIN_SCAN_ISSUES = 16

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

export async function scanKnownPluginSkillCandidates(
  rootPath: string,
  knownNames: ReadonlySet<string>,
  maximumCandidates = MAXIMUM_PLUGIN_SKILL_CANDIDATES
): Promise<KnownPluginSkillScan> {
  const candidates: KnownPluginSkillCandidate[] = []
  const issues: KnownPluginSkillScanIssue[] = []
  const issueKeys = new Set<string>()
  const visited = new Set<string>()
  let resolvedRoot: string | null = null
  let entryCount = 0
  let limitReached = false

  function recordIssue(
    path: string,
    reason: KnownPluginSkillScanIssue['reason'],
    code: string | null = null
  ): void {
    const key = `${path}\0${reason}\0${code ?? ''}`
    if (issueKeys.has(key)) {
      return
    }
    if (issues.length >= MAXIMUM_PLUGIN_SCAN_ISSUES) {
      issues.splice(0, issues.length, {
        path: rootPath,
        reason: 'issue-limit',
        errorCode: null
      })
      limitReached = true
      return
    }
    issueKeys.add(key)
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

  async function visit(
    directory: string,
    depth: number,
    withinDeclaredSkillRoot = false
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
        if (entryCount > MAXIMUM_PLUGIN_SCAN_ENTRIES) {
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

    const skillFile = entries.find((entry) => entry.name === 'SKILL.md')
    if (withinDeclaredSkillRoot && skillFile) {
      let isSkillFile = skillFile.isFile()
      if (skillFile.isSymbolicLink()) {
        try {
          isSkillFile = (await stat(join(directory, skillFile.name))).isFile()
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            recordIssue(join(directory, skillFile.name), 'io-error', errorCode(error))
          }
          isSkillFile = false
        }
      }
      if (isSkillFile) {
        const name = basename(directory)
        if (knownNames.has(name)) {
          recordCandidate(name, directory)
        }
      }
    }

    const skillRoots = await declaredPluginSkillRoots(directory, entries, resolvedRoot, recordIssue)
    if (limitReached) {
      return
    }
    if (skillRoots) {
      const skillRootDepth = withinDeclaredSkillRoot ? depth + 1 : 0
      for (const skillRoot of skillRoots.sort()) {
        entryCount += 1
        if (entryCount > MAXIMUM_PLUGIN_SCAN_ENTRIES) {
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
          if (errorCode(error) !== 'ENOENT') {
            recordIssue(entryPath, 'io-error', errorCode(error))
          }
          if (knownNames.has(entry.name)) {
            recordCandidate(entry.name, entryPath)
          }
          continue
        }
      }
      if (!directoryEntry) {
        continue
      }
      if (!withinDeclaredSkillRoot && knownNames.has(entry.name)) {
        recordCandidate(entry.name, entryPath)
        continue
      }
      await visit(entryPath, depth + 1, withinDeclaredSkillRoot)
    }
  }

  await visit(rootPath, 0)
  return { candidates, issues }
}
