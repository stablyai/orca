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

// Bound requests change source signatures the same way bound provider, workspace-creation and
// settings requests did: the method string and the envelope read leave the screen and an operation
// name arrives. The behaviour they used to pin is pinned by the recordings in
// mobile/rpc-foundation/goldens instead, which did not move.
//
// The screen-holdout migration takes the last two sends out of this family — the filter sheet's
// linear.selectWorkspace and the screen-root hook's repo.list. Hook, statement, declaration, render
// and style counts are all unchanged, and `semantics` is a pure deletion of four lines, none in:
// two `rpc:` call signatures and the two method literals they carried. The render-token hash moves
// because the picker's handler now names an operation instead of the client.
//
// Step 7 moves the hook, statement, declaration and semantic hashes and no count. Hooks stay at
// 350 and 28 of them move, every one a body this migration edited; no dependency array changes,
// which is what a hook signature is here to pin. Statements hold at 417 and declarations at 194:
// checked readers delete type assertions, not statements. `semantics` loses exactly four lines,
// and all four are string literals that lived INSIDE the one deleted inline cast type in
// use-mobile-tasks-project-detail-loading.tsx — `'DISMISSED'`, `'VIEWED'`, `'UNVIEWED'` and the
// `['status']` index into GitHubDetailFile. No method literal and no `rpc:` call signature moves,
// which is the property this family exists to hold.
const SCREEN_RPC_SCREEN_HOOKS = '0f015615e608e48f179566606c93b65758093c4a08e853d382eec888d95b79be'
const PRE_REFACTOR_DIFF_HOOKS = '93c7189b32bed8456cc51814fffa8ce80cf62011ef968a9d53ddec2b9686f58f'
const SCREEN_RPC_STATEMENTS = 'ebd1826ccf1737329ac7270fc71a624f56223ddb90ecde739a30fa25ef92e872'
const MAIN_REBASED_DECLARATIONS = 'f6f5fe2cc09dfd91f8f7048ab0ce11579cd2618e234079d2ab403bea4fb7161d'
const SCREEN_RPC_SEMANTICS = '9bea10a73a501bbb09b825ca62119f808640e40940b3a5f1dce0493aa5452314'
const PRE_REFACTOR_STYLES = '1db6af69c791d9963928541ad5310942fcbda6d984b422c90b6eb92b6816579a'
const SCREEN_RPC_RENDER_TREE = '46d5a3ce9d71a8281a1e7b17411fb1dd963a4f392a5d095bc126b6a7cff4b92d'

describe('Mobile Tasks refactor parity', () => {
  it('preserves recursively flattened hook and dependency order', () => {
    const screenHooks = readFlattenedMobileTasksHookSignatures('MobileTasksScreen')
    expect(screenHooks).toHaveLength(350)
    expect(hash(screenHooks)).toBe(SCREEN_RPC_SCREEN_HOOKS)

    const diffHooks = readFlattenedMobileTasksHookSignatures('GitHubPrFileDiff')
    expect(diffHooks).toHaveLength(3)
    expect(hash(diffHooks)).toBe(PRE_REFACTOR_DIFF_HOOKS)
  })

  it('preserves every screen statement in execution order', () => {
    const statements = readFlattenedMobileTasksCoreStatements()
    expect(statements).toHaveLength(417)
    expect(hash(statements)).toBe(SCREEN_RPC_STATEMENTS)
  })

  it('preserves every moved top-level declaration', () => {
    const declarations = readMobileTasksDeclarationSignatures()
    expect(declarations).toHaveLength(194)
    expect(hash(declarations)).toBe(MAIN_REBASED_DECLARATIONS)
  })

  it('preserves RPC calls, runtime strings, and JSX host signatures', () => {
    const semantics = readMobileTasksSemanticSource()
    expect(semantics.split('\n')).toHaveLength(3_296)
    expect(hash(semantics)).toBe(SCREEN_RPC_SEMANTICS)
  })

  it('preserves render expressions and event handlers in tree order', () => {
    const tokens = readFlattenedMobileTasksRenderTokens()
    expect(tokens).toHaveLength(35_195)
    expect(hash(tokens)).toBe(SCREEN_RPC_RENDER_TREE)
  })

  it('preserves every StyleSheet property and value', () => {
    expect(hash(readMobileTasksStyleSource())).toBe(PRE_REFACTOR_STYLES)
  })
})
