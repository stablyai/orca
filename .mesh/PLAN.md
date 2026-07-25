# Pre-hub M1 + E2 execution plan

**Goal:** close the Orca fork's M1 session voice FAB and E2 Nord board gate before any meshina hub implementation.
**Repo:** `/home/nixos/orca-pet`
**Branch:** `feat/pet-full-port`

## Scope

1. M1: consume `mobile/src/voice/session-voice-contract.ts`; add a session-scoped FAB chooser for Orca mother sessions, native `useMobileDictation` input, `buildVoiceAttach` injection, and explicit capability/error states.
2. E2: audit and prove the existing mobile board route and host-panel entry. Fix only concrete gaps.
3. Dogfood both paths on the Nord after code gates.

## Constraints

- Do not reimplement native STT or terminal injection.
- Preserve existing voice, collab canvas, and session behavior.
- File-touch work is local proposal only. No push from the worker.
- No gateway restart.
- Hub work remains locked until M1 and E2 receipts plus Nord dogfood exist.

## Verification

- `pnpm --dir mobile test`
- `pnpm --dir mobile typecheck`
- `pnpm --dir mobile lint`
- Focused collab and voice contract tests.
- Operator-visible Nord APK dogfood with honest receipt.
