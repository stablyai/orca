# Spec: Fix Chat UI Showing Out-of-Sequence Messages (Issue #23851)

## Current State

In `src/renderer/src/components/native-chat/native-chat-session-assembler.ts`, `messageSortRank` previously classified messages into artificial tiers where pending user prompts were ranked 2 and streaming previews were ranked 1. This caused pending user prompts to sort after streaming previews and assistant responses. Additionally, clock skew between host and client could cause launch prompt pruning to fail.

The fix unifies user message sorting precedence:
1. Pending user prompts and authoritative messages sort by timestamp chronologically.
2. The active streaming preview sits directly after the user prompt that triggered it.
3. Pending send and launch prompt pruning are tolerant of cross-host clock skew.
4. Adversarial review identified and resolved two edge cases in `pendingSendsAsMessages`:
   - Handled post-pruning React state cycle: when a prior follow-up is pruned from `pending` after landing in the transcript, subsequent follow-up sends remain queued behind the in-progress transcript turn.
   - Handled null `hookWorkingEpoch`: when an agent is live-working (e.g. scrape/terminal turn), explicitly queued sends remain queued even if `hookWorkingEpoch` is not yet available.

All 108 targeted Vitest tests pass, web typecheck is clean, oxlint has 0 issues, and `check:code-quality:changed` passes with 0 findings.
## Summary

Restore strict chronological ordering in `compareMessages` and message assembly:
1. Pending user prompts must not sort after subsequent assistant responses or streaming previews. User prompts appear before the agent response that answers them.
2. In `compareMessages`, chronological timestamps take precedence for user prompts so pending user prompts sort by submission order.
3. The streaming preview (`NATIVE_CHAT_STREAMING_ID`) with `null` timestamp sorts directly after the user prompt that triggered it, never before the user prompt.
4. Launch prompt pruning and pending send matching remain robust against minor clock skew between host and client.

## Files to Touch

- `src/renderer/src/components/native-chat/native-chat-session-assembler.ts`
- `src/renderer/src/components/native-chat/NativeChatResolvedView.tsx`
- `src/renderer/src/components/native-chat/native-chat-pending.ts`
- `src/renderer/src/components/native-chat/use-native-chat-pending-delivery.ts`
- `src/renderer/src/components/native-chat/native-chat-message-grouping.test.ts`
- `src/renderer/src/components/native-chat/native-chat-session-assembler.test.ts`
- `src/renderer/src/components/native-chat/native-chat-pending.test.ts`
- `src/renderer/src/components/native-chat/native-chat-pending-queued.test.ts`
- `src/renderer/src/components/native-chat/use-native-chat-pending-delivery.test.tsx`

## Step-by-Step

1. **Step 1 (TDD Red Test)**: Add unit tests in `native-chat-message-grouping.test.ts` and `native-chat-session-assembler.test.ts` asserting that pending prompts sort before subsequent assistant responses and streaming previews.
2. **Step 2 (Build/Fix)**:
   - Adjust `messageSortRank` and `compareMessages` in `native-chat-session-assembler.ts` so pending user messages sort by their chronological timestamp.
   - Adjust mount order in `NativeChatResolvedView.tsx` so optimistic user echoes mount before active streaming response.
   - Ensure launch prompt timestamp matching tolerates clock skew.
3. **Step 3 (TDD Green Execution)**:
   - Run Vitest suite: 108 targeted unit tests pass.
4. **Step 4 (PR Review - riley-pr-agent)**:
   - Verified clean diff with no regressions.
5. **Step 5 (Gate Checks - riley-pr-check)**:
   - Vitest: 108 passed.
   - TypeScript `pnpm tc:web`: 0 errors.
   - Linter `oxlint`: 0 issues.
   - `check:code-quality:changed`: 0 findings across all 8 changed files.
6. **Step 6 (Expert Maintainer Audit - riley-the-maintainer)**:
   - Merge verdict: APPROVED.

## Verification

- `HUSKY=0 pnpm vitest run --config config/vitest.config.ts src/renderer/src/components/native-chat/native-chat-session-assembler.test.ts src/renderer/src/components/native-chat/native-chat-message-grouping.test.ts src/renderer/src/components/native-chat/native-chat-pending.test.ts src/renderer/src/components/native-chat/native-chat-pending-queued.test.ts src/renderer/src/components/native-chat/use-native-chat-pending-delivery.test.tsx`
- `npx oxlint src/renderer/src/components/native-chat/NativeChatResolvedView.tsx src/renderer/src/components/native-chat/native-chat-pending.ts src/renderer/src/components/native-chat/native-chat-session-assembler.ts src/renderer/src/components/native-chat/use-native-chat-pending-delivery.ts`
- `pnpm run check:code-quality:changed`

## Notes for Next Agent

- All changes are committed to branch `ai/bug-chat-ui-showing-out-of-sequence-messages`.
- PR is ready to open/merge.
