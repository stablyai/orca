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
// Step 7's first half moves four of the six again, and moves nothing else. Checked readers on the
// item and list operations delete the reply casts these consumers carried, plus the three shape
// tests the reader now answers for: both `Array.isArray(payload)` guards on the checks read and the
// `typeof count === 'number'` fallback on the item count. Hook, statement, declaration and render
// counts are unchanged, and the render-token hash does not move at all — nothing this family sees
// changed inside a JSX tree. `semantics` is a pure deletion of ten lines.
//
// Round-1 review moves four, and names what each one is. The reaction reader stops matching
// `content` against an arm set mobile invented and forwards it, so `DetailComment` loses the eight
// phantom arms and `COMMENT_REACTION_EMOJI` stops being keyed by them: that is ten string literals
// gone and the `?? ''` fallback's one added, the whole of `semantics`' 3,290 -> 3,281. The eight
// alias-only bindings the deleted casts left behind (`const result = created` and its seven
// siblings) are inlined, which moves the hook and statement hashes without moving their counts.
// Only those eight: the Linear arm of task creation keeps its own `result`, which is a declaration
// with a name rather than an alias for one.
// No `rpc:` signature and no `jsx:` signature moves, the render-token hash does not move, and
// counts stay at 350 hooks, 417 statements and 194 declarations.
//
// The `gitlab.todos` fixture correction moves the same three hashes once more and no others: the
// to-do row is checked now, so the reader's cast is gone from the list-loading hook and the row
// type it forwarded is declared by what the reader proves. Counts are unchanged again, and
// `semantics` does not move, because no RPC call, runtime string or JSX host signature does.
//
// Round 2 moves two, and only because one member widens. `GitHubDetailFile.viewerViewedState` is
// `string` rather than the host's three arms, because the reader forwards it now: that is the
// declaration hash and the three arm literals, `semantics` 3,281 -> 3,278. `status` keeps its arms
// and moves nothing, because its only consumer sends it back as a param the host validates against
// the same set. Hook, statement and render hashes do not move; nothing executable changed.
//
// Step 7's tasks-2 half moves the hook, statement, declaration and semantic hashes once more, for
// the board, runtime, search, workspace-source and workspace-create operations, and moves no count:
// hooks stay at 350, statements at 417, declarations at 194. `semantics` is a pure deletion of four
// lines, 3,278 -> 3,274, and all four are the literals inside the one inline cast type this half
// deletes in use-mobile-tasks-project-detail-loading.tsx — `'DISMISSED'`, `'VIEWED'`, `'UNVIEWED'`
// and the `['status']` index into GitHubDetailFile. No method literal and no `rpc:` call signature
// moves.
//
// The hook and statement hashes also move for comment text alone: `normalized` reads a statement's
// full span, so a comment nested inside one is hashed with it. They move once more when the two
// halves are deduplicated: the project pane's five collection casts and the assignee list's are
// deleted where the entity schemas from the item half now type those rows.
//
// Round 2 of tasks-2 moves the hook and statement hashes a last time, and only those two. One
// statement changes: the Linear list cast (`found as LinearIssue[]`) becomes `found`, because the
// nine members linearIssueRowSchema requires make the value assignable to the mobile alias without
// it. The rest is comment text nested inside statements — three `SAFETY:` lines rewritten to argue
// from the schemas that landed instead of the fixtures round 1 deleted. Counts are unchanged at 350
// hooks and 417 statements; the declaration, semantic, render and style hashes do not move, which
// is the evidence that deleting the cast changed no type and no call.
//
// The pullfrog pass on the same round moved both once more, again by comment text alone: the
// GitHub search `SAFETY:` line now separates the two members the schema requires (`items`,
// `labels`) from the eight it only types. No statement, type or call changed; counts hold.
// C2.1 swaps the workspace-creation push onto `hostNewWorktreeSessionRoute`, which already built
// this href with both segments encoded. Three of the family move and nothing else does: the hook
// list, because the handler's statements changed shape; the statement hash, for the same reason;
// and `semantics`, which is a pure deletion of two lines — the `URLSearchParams` construction and
// the raw `/h/${hostId}/session/...` template it fed. No RPC call, method literal or JSX host
// signature changed, and the render and style hashes did not move.

// C2.1 swaps the two clipboard writes onto the platform seam, so the comment-review hook gains one
// hook call and one statement. Two of the family move: the hook list and the statement hash, each
// by one entry. `semantics` does not — no RPC call, method literal or JSX host signature changed —
// and the render and style hashes hold.

// C2.8 names the status bar's Back control for the shell, which has no native chrome behind it to
// announce one. `accessibilityRole="button"` and `accessibilityLabel="Back"` on that one Pressable
// move the two hashes a JSX prop must move, and only those two. `semantics` 3,272 -> 3,274: the
// element's host signature widens (`jsx:Pressable:style,onPress` -> the same plus the two props)
// and the two new runtime strings `"button"` and `"Back"` arrive. The render-token stream gains
// the eight tokens those two attributes are, 35,195 -> 35,203. No RPC call signature and no method
// literal moves, and the hook, statement, declaration and style hashes do not move at all, which
// is the evidence that nothing executable changed.
//
// The same commit gives that control the `hitSlop={8}` its four siblings carry, so its touch
// target is no longer the glyph alone. One more line of `semantics` changes and no line is added
// or removed — the host signature gains `hitSlop` — so the count holds at 3,274 and only the hash
// moves. The render-token stream gains the four tokens that one attribute is, 35,203 -> 35,207.
// Nothing else in the family moves.

const SCREEN_RPC_SCREEN_HOOKS = '0f66df2141117dfec2f8a0adb3f598312e6fda8e80833a365a645796f5ab48c3'
const PRE_REFACTOR_DIFF_HOOKS = '93c7189b32bed8456cc51814fffa8ce80cf62011ef968a9d53ddec2b9686f58f'
const SCREEN_RPC_STATEMENTS = 'dd8f33cb3cf96f5c39abac397cb77e35f59079291033a1866ead462b041ab979'
// Saved Linear selections now accept unknown persisted values; reconciliation tests cover them.
const MAIN_REBASED_DECLARATIONS = 'ec77d34712c7c4ab19ac6a4d57878f32d22aba790d2420cc14c2c0f000d120e9'
const SCREEN_RPC_SEMANTICS = 'e07a63387d57106483ee703ec6c19dea593e0eca5c651758f42bcb36254850b7'
const PRE_REFACTOR_STYLES = '1db6af69c791d9963928541ad5310942fcbda6d984b422c90b6eb92b6816579a'
const SCREEN_RPC_RENDER_TREE = '086742f95f1e87fb89d8c67ffd9f7a229799ae05115f9f4bcc1a925e56dcc8bb'

describe('Mobile Tasks refactor parity', () => {
  it('preserves recursively flattened hook and dependency order', () => {
    const screenHooks = readFlattenedMobileTasksHookSignatures('MobileTasksScreen')
    expect(screenHooks).toHaveLength(351)
    expect(hash(screenHooks)).toBe(SCREEN_RPC_SCREEN_HOOKS)

    const diffHooks = readFlattenedMobileTasksHookSignatures('GitHubPrFileDiff')
    expect(diffHooks).toHaveLength(3)
    expect(hash(diffHooks)).toBe(PRE_REFACTOR_DIFF_HOOKS)
  })

  it('preserves every screen statement in execution order', () => {
    const statements = readFlattenedMobileTasksCoreStatements()
    expect(statements).toHaveLength(418)
    expect(hash(statements)).toBe(SCREEN_RPC_STATEMENTS)
  })

  it('preserves every moved top-level declaration', () => {
    const declarations = readMobileTasksDeclarationSignatures()
    expect(declarations).toHaveLength(194)
    expect(hash(declarations)).toBe(MAIN_REBASED_DECLARATIONS)
  })

  it('preserves RPC calls, runtime strings, and JSX host signatures', () => {
    const semantics = readMobileTasksSemanticSource()
    expect(semantics.split('\n')).toHaveLength(3_274)
    expect(hash(semantics)).toBe(SCREEN_RPC_SEMANTICS)
  })

  it('preserves render expressions and event handlers in tree order', () => {
    const tokens = readFlattenedMobileTasksRenderTokens()
    expect(tokens).toHaveLength(35_207)
    expect(hash(tokens)).toBe(SCREEN_RPC_RENDER_TREE)
  })

  it('preserves every StyleSheet property and value', () => {
    expect(hash(readMobileTasksStyleSource())).toBe(PRE_REFACTOR_STYLES)
  })
})
