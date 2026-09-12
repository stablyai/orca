import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  readFlattenedMobileTasksHookSignatures,
  readMobileTasksSemanticSource,
  readMobileTasksStyleSource
} from './mobile-tasks-source-family.test-support'
import { readFlattenedMobileTasksRenderTokens } from './mobile-tasks-render-parity.test-support'
import {
  readFlattenedMobileTasksCoreStatements,
  readMobileTasksDeclarationSignatures
} from './mobile-tasks-execution-parity.test-support'

const hash = (parts: string[] | string): string =>
  createHash('sha256')
    .update(Array.isArray(parts) ? parts.join('\n') : parts)
    .digest('hex')

// Task-sort key precomputation is covered by mobile-task-sort.test.ts; other source guards remain.
const EXPECTED_SCREEN_HOOKS = '6bbbbbcea5faec9cef22c9e7b4ada24b69517bd7d6bd03259e5f239eca036a9d'
const EXPECTED_DIFF_HOOKS = '93c7189b32bed8456cc51814fffa8ce80cf62011ef968a9d53ddec2b9686f58f'
const EXPECTED_STATEMENTS = '71b6d3e02022568b0300cba3fa33e19b39509b9bfd987af6bb6f7d378a75939c'
const EXPECTED_DECLARATIONS = 'e79d877078362cef301ac8bdc46fef07eb0ac9414e5b8f752a879559ec6dbde1'
const EXPECTED_SEMANTICS = '4758ba019e4ff7cadd7ee02338719fa4fc4e1443e34cc290842819cfa1a70181'
const EXPECTED_STYLES = '1db6af69c791d9963928541ad5310942fcbda6d984b422c90b6eb92b6816579a'
const EXPECTED_RENDER_TREE = '2111145136b1e4fbca150d4792d735a90e992488e9934cfc1a8b8f3be981f39f'

describe('Mobile Tasks refactor parity', () => {
  it('preserves recursively flattened hook and dependency order', () => {
    const screenHooks = readFlattenedMobileTasksHookSignatures('MobileTasksScreen')
    expect(screenHooks).toHaveLength(350)
    expect(hash(screenHooks)).toBe(EXPECTED_SCREEN_HOOKS)

    const diffHooks = readFlattenedMobileTasksHookSignatures('GitHubPrFileDiff')
    expect(diffHooks).toHaveLength(3)
    expect(hash(diffHooks)).toBe(EXPECTED_DIFF_HOOKS)
  })

  it('preserves every screen statement in execution order', () => {
    const statements = readFlattenedMobileTasksCoreStatements()
    expect(statements).toHaveLength(417)
    expect(hash(statements)).toBe(EXPECTED_STATEMENTS)
  })

  it('preserves every moved top-level declaration', () => {
    const declarations = readMobileTasksDeclarationSignatures()
    expect(declarations).toHaveLength(192)
    expect(hash(declarations)).toBe(EXPECTED_DECLARATIONS)
  })

  it('preserves RPC calls, runtime strings, and JSX host signatures', () => {
    const semantics = readMobileTasksSemanticSource()
    expect(semantics.split('\n')).toHaveLength(3_500)
    expect(hash(semantics)).toBe(EXPECTED_SEMANTICS)
  })

  it('preserves render expressions and event handlers in tree order', () => {
    const tokens = readFlattenedMobileTasksRenderTokens()
    expect(tokens).toHaveLength(35_195)
    expect(hash(tokens)).toBe(EXPECTED_RENDER_TREE)
  })

  it('preserves every StyleSheet property and value', () => {
    expect(hash(readMobileTasksStyleSource())).toBe(EXPECTED_STYLES)
  })
})
