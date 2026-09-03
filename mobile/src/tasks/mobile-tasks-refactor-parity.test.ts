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

// These baselines were captured from the pure-move refactor (#16165 and the
// Tasks-screen split). Adding Jira as a mobile task provider necessarily changes
// hook count, statements, declarations, render tokens, and styles, so they are
// re-captured here rather than left failing. GitHubPrFileDiff's hash is
// deliberately unchanged — the port touched no code outside the Tasks surface.
const PRE_REFACTOR_SCREEN_HOOKS = 'f653fe089e93d442924a2842ada2a814fe758dd8be637a448167f9e16666bc03'
const PRE_REFACTOR_DIFF_HOOKS = '93c7189b32bed8456cc51814fffa8ce80cf62011ef968a9d53ddec2b9686f58f'
const PRE_REFACTOR_STATEMENTS = '343d4ea2822b84f1fba353a2302354463b0567290b95f6bfca90b331ab32bcf3'
const PRE_REFACTOR_DECLARATIONS = '84059cfd087dfe7295f59708645a0ba330142287672bcceb92b7d1b50286d1f1'
const PRE_REFACTOR_SEMANTICS = 'bfb28e2aad85711b4661927c8428dddede24e0e1fbe4cd93402324054fe19a8f'
const PRE_REFACTOR_STYLES = '03787649f5e97089b07779886a920f68a0dfc27f7409c81ae9711530c78975e6'
const PRE_REFACTOR_RENDER_TREE = '2f8f9585a9e720776da2b4be1f7d3f2cd8d8848e69bed6d4cff5fd6970745e6c'

describe('Mobile Tasks refactor parity', () => {
  it('preserves recursively flattened hook and dependency order', () => {
    const screenHooks = readFlattenedMobileTasksHookSignatures('MobileTasksScreen')
    expect(screenHooks).toHaveLength(358)
    expect(hash(screenHooks)).toBe(PRE_REFACTOR_SCREEN_HOOKS)

    const diffHooks = readFlattenedMobileTasksHookSignatures('GitHubPrFileDiff')
    expect(diffHooks).toHaveLength(3)
    expect(hash(diffHooks)).toBe(PRE_REFACTOR_DIFF_HOOKS)
  })

  it('preserves every screen statement in execution order', () => {
    const statements = readFlattenedMobileTasksCoreStatements()
    expect(statements).toHaveLength(428)
    expect(hash(statements)).toBe(PRE_REFACTOR_STATEMENTS)
  })

  it('preserves every moved top-level declaration', () => {
    const declarations = readMobileTasksDeclarationSignatures()
    expect(declarations).toHaveLength(195)
    expect(hash(declarations)).toBe(PRE_REFACTOR_DECLARATIONS)
  })

  it('preserves RPC calls, runtime strings, and JSX host signatures', () => {
    const semantics = readMobileTasksSemanticSource()
    expect(semantics.split('\n')).toHaveLength(3_546)
    expect(hash(semantics)).toBe(PRE_REFACTOR_SEMANTICS)
  })

  it('preserves render expressions and event handlers in tree order', () => {
    const tokens = readFlattenedMobileTasksRenderTokens()
    expect(tokens).toHaveLength(35_754)
    expect(hash(tokens)).toBe(PRE_REFACTOR_RENDER_TREE)
  })

  it('preserves every StyleSheet property and value', () => {
    expect(hash(readMobileTasksStyleSource())).toBe(PRE_REFACTOR_STYLES)
  })
})
