import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { sanitizeWorktreeBranchName } from './worktree-logic'

const ADVERSARIAL_INPUTS = [
  'feature/tti_fix_1440',
  'feature/tti fix',
  '/feature//tti/',
  'foo/../bar',
  'feature/.hidden',
  'feature/tti.lock',
  'feature/tti.LOCK',
  'feature/tti.lock.lock',
  'feature/tti.Lock.lock',
  'a..b/c...d',
  'feature/中文',
  'feature/🚀',
  'feat: 中文 (v2)',
  'a/b/c/d/e',
  'feature/tti@{v2}',
  'feature/tti~1',
  'feature/tti^2',
  'feature/tti:1',
  'feature/tti?',
  'feature/tti*',
  'feature/tti[1]',
  'feature/tti\\win',
  'feature/tti fix 123',
  '...',
  '///',
  'a/./b',
  'feature/tti.',
  'feature/.tti',
  'feature/-tti-',
  'feature/tti--fix',
  'feature/tti.lock.bak',
  'feature/tti_lock',
  'FEATURE/Tti_Fix',
  'feature/123',
  'feature/tti(fix)',
  'feature/tti[fix]',
  'feature/tti@fix',
  'feature/tti+fix',
  'feature/tti=fix',
  'feature/tti&fix',
  'feature/tti%fix',
  'feature/tti#fix',
  'feature/tti!fix',
  'feature/tti`fix`',
  'feature/tti|fix',
  'feature/tti;fix',
  'feature/tti"fix"',
  "feature/tti'fix'",
  'feature/tti<fix>',
  'feature/tti{fix}',
  'feature/tti fix / v2',
  '\tfeature/tti\n',
  'feature//tti///fix',
  'feature/tti fix/other thing',
  'feature/日本語/テスト',
  'feature/Привет/мир',
  'feature/café/déjà',
  'feature/🚀/✨',
  'feature/1️⃣/2️⃣'
]

describe('sanitizeWorktreeBranchName git validity', () => {
  it('produces names git check-ref-format accepts for every adversarial input', () => {
    const failures: string[] = []
    for (const input of ADVERSARIAL_INPUTS) {
      let branch: string
      try {
        branch = sanitizeWorktreeBranchName(input)
      } catch {
        // Throwing on unusable input is acceptable.
        continue
      }
      try {
        execFileSync('git', ['check-ref-format', '--branch', branch], { stdio: 'pipe' })
      } catch {
        failures.push(`${JSON.stringify(input)} -> ${JSON.stringify(branch)}`)
      }
    }
    expect(failures).toEqual([])
  })
})
