// Redaction and atomic-write tests for the plan artifact store.
//
// Redaction is best-effort by design (see the module header), so these assert
// the patterns it DOES claim to cover, plus the durability properties the crash
// model depends on.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_PLAN_ARTIFACT_CHARS,
  MAX_REVIEW_SUMMARY_CHARS,
  getPlanArtifactFilePath,
  hashPlanText,
  planArtifactFileExists,
  readPlanArtifactFile,
  sanitizePlanText,
  sanitizeReviewSummary,
  writePlanArtifactFileAtomically
} from './audited-plan-artifact-store'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-artifact-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

const CONTEXT = {
  worktreePath: 'C:\\Users\\alice\\orca\\worktrees\\task-1',
  sourceRepoPath: 'C:\\Users\\alice\\orca',
  sourceRepoCommonDir: 'C:\\Users\\alice\\orca\\.git',
  branchName: 'audited/task-1',
  userDataPath: 'C:\\Users\\alice\\AppData\\Roaming\\Orca',
  homePath: 'C:\\Users\\alice'
}

describe('sanitizePlanText', () => {
  it('redacts the worktree path in all three spellings', () => {
    const raw = [
      'Edit C:\\Users\\alice\\orca\\worktrees\\task-1\\src\\a.ts',
      'Edit C:/Users/alice/orca/worktrees/task-1/src/b.ts',
      'Edit C:\\\\Users\\\\alice\\\\orca\\\\worktrees\\\\task-1\\\\src\\\\c.ts'
    ].join('\n')
    const result = sanitizePlanText(raw, CONTEXT)
    expect(result.text).not.toContain('alice')
    expect(result.text).not.toContain('task-1\\src')
    expect(result.redactionCount).toBeGreaterThanOrEqual(3)
  })

  it('redacts the branch name', () => {
    const result = sanitizePlanText('Work on audited/task-1 then stop.', CONTEXT)
    expect(result.text).not.toContain('audited/task-1')
    expect(result.text).toContain('\u2039branch\u203a')
  })

  it.each([
    ['an OpenAI key', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['a GitHub PAT', 'github_pat_11ABCDEFG0abcdefghijklmnop'],
    ['a classic GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['a Slack token', 'xoxb-1234567890-abcdefghijkl'],
    ['an AWS key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789']
  ])('redacts %s', (_label, secret) => {
    const result = sanitizePlanText(`Use ${secret} to authenticate.`, CONTEXT)
    expect(result.text).not.toContain(secret)
    expect(result.text).toContain('\u2039redacted\u203a')
  })

  it('redacts a PEM private key block', () => {
    const raw = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    const result = sanitizePlanText(raw, CONTEXT)
    expect(result.text).not.toContain('MIIEowIBAAKCAQEA')
  })

  it('redacts generic home paths not passed in context', () => {
    const result = sanitizePlanText('See /Users/bob/secret/notes.md for details.', {})
    expect(result.text).not.toContain('/Users/bob')
  })

  it('strips ANSI control sequences', () => {
    const result = sanitizePlanText(`\u001b[31mStep 1\u001b[0m`, CONTEXT)
    expect(result.text).toBe('Step 1')
  })

  it('strips NUL and normalizes CRLF so the hash is platform-stable', () => {
    const result = sanitizePlanText('a\r\nb\0c', CONTEXT)
    expect(result.text).toBe('a\nbc')
  })

  it('bounds an oversized plan and reports truncation', () => {
    const result = sanitizePlanText('x'.repeat(MAX_PLAN_ARTIFACT_CHARS * 2), CONTEXT)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(MAX_PLAN_ARTIFACT_CHARS)
  })

  it('leaves a clean plan untouched and reports no redactions', () => {
    const result = sanitizePlanText('1. Add a test.\n2. Fix the bug.', CONTEXT)
    expect(result.text).toBe('1. Add a test.\n2. Fix the bug.')
    expect(result.redactionCount).toBe(0)
    expect(result.truncated).toBe(false)
  })
})

describe('sanitizeReviewSummary', () => {
  it('bounds the summary to the storage cap', () => {
    const summary = sanitizeReviewSummary('y'.repeat(MAX_REVIEW_SUMMARY_CHARS * 2), CONTEXT)
    expect(summary.length).toBeLessThanOrEqual(MAX_REVIEW_SUMMARY_CHARS)
  })

  it('redacts secrets in model-authored summaries too', () => {
    const summary = sanitizeReviewSummary('Found sk-abcdefghijklmnopqrstuvwxyz012345', CONTEXT)
    expect(summary).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })
})

describe('writePlanArtifactFileAtomically', () => {
  it('writes the body and returns a matching hash', () => {
    const dir = tempDir()
    const result = writePlanArtifactFileAtomically(dir, 'plan_a', 'the plan')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.sha256).toBe(hashPlanText('the plan'))
    expect(result.charCount).toBe('the plan'.length)
    expect(readFileSync(getPlanArtifactFilePath(dir, 'plan_a'), 'utf8')).toBe('the plan')
  })

  it('leaves no temp file behind on success', () => {
    const dir = tempDir()
    writePlanArtifactFileAtomically(dir, 'plan_b', 'body')
    const files = readdirSync(join(dir, 'audited-workflow', 'plans', 'plan_b'))
    expect(files).toEqual(['plan.md'])
  })

  it('reports the file as existing only after a successful write', () => {
    const dir = tempDir()
    expect(planArtifactFileExists(dir, 'plan_c')).toBe(false)
    writePlanArtifactFileAtomically(dir, 'plan_c', 'body')
    expect(planArtifactFileExists(dir, 'plan_c')).toBe(true)
  })

  it('fails closed without creating a final file when the path is unusable', () => {
    const dir = tempDir()
    // A regular file where the artifact DIRECTORY must go: mkdir fails, so the
    // write must report failure rather than throw a path at the caller.
    const plansRoot = join(dir, 'audited-workflow', 'plans')
    rmSync(plansRoot, { recursive: true, force: true })
    writeFileSync(join(dir, 'blocker'), 'x', 'utf8')
    const result = writePlanArtifactFileAtomically(join(dir, 'blocker'), 'plan_d', 'body')
    expect(result.ok).toBe(false)
    expect(existsSync(getPlanArtifactFilePath(join(dir, 'blocker'), 'plan_d'))).toBe(false)
  })
})

describe('readPlanArtifactFile', () => {
  it('returns null rather than throwing when the artifact is missing', () => {
    expect(readPlanArtifactFile(tempDir(), 'plan_missing')).toBeNull()
  })

  it('round-trips a written body', () => {
    const dir = tempDir()
    writePlanArtifactFileAtomically(dir, 'plan_e', 'round trip')
    expect(readPlanArtifactFile(dir, 'plan_e')).toBe('round trip')
  })
})
