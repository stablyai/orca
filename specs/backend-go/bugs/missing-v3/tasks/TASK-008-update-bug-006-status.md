# TASK-008: Update BUG-006's status note once the suppressor change lands

**From Solution:** SOL-006
**Priority:** P2 — pure documentation, do last within this pair
**Service:** docs (`specs/`)
**File:** `specs/backend-go/bugs/missing-v3/BUG-006-speech-models-channels-not-implemented.md`
**Depends on:** TASK-007
**Status:** `[x]` DONE — as specified. Updated `BUG-006`'s status line and `README.md`'s Bug index row (Title + Kind columns) exactly per the sketch; left the "11 real, confirmed gaps filed" summary line and the `BUG-004`–`BUG-006` range reference untouched as instructed (historical framing). Markdown link syntax verified by inspection (no broken brackets/parens).

---

## Context

BUG-006's current status line already anticipates this exact follow-up — it explicitly says the "will not be implemented, by design" verdict is reached, but the doc is deliberately left as **"Open"** until the one remaining action item (adding `speech` to `DESKTOP_ONLY_NAMESPACES`) is actually done. Once TASK-007 ships, this line is stale and should be updated to close the loop — otherwise BUG-006 permanently reads as "still open" even after the only real action it names is complete.

## Changes to make

Current status line (`BUG-006-speech-models-channels-not-implemented.md:10-20`, verbatim):

```markdown
**Status:** ⚠️ Open, but reclassified during solution design — see
[`solutions/SOL-006-speech-models-channels.md`](./solutions/SOL-006-speech-models-channels.md):
deeper investigation concluded this should **not** be implemented as a
backend-go RPC at all. Dictation always targets the paired desktop process
holding the local model files — there is no dev-server/worktree concept to
relay to, unlike `ephemeralVm.*`/`browser.*`. The recommended fix is adding
`speech` to `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts`'s
`DESKTOP_ONLY_NAMESPACES` (currently absent — a live, unclassified gap
today) rather than building a backend-go implementation. Left as "Open"
here since the suppressor change itself is still undone; treat the
severity/description below as the pre-investigation framing.
```

Replace with (mirroring how this same `missing-v3` set's own house style closes out a "will not implement" verdict — check `BUG-004`'s framing for `ephemeralVm`'s Group 2b if a closer local precedent is wanted, though that one stays open since Group 1/2a genuinely ship):

```markdown
**Status:** ✅ Resolved, by design — **not implemented as a backend-go RPC**.
See [`solutions/SOL-006-speech-models-channels.md`](./solutions/SOL-006-speech-models-channels.md)
for the full investigation: dictation always targets the paired desktop
process holding the local model files — there is no dev-server/worktree
concept to relay to, unlike `ephemeralVm.*`/`browser.*`. The one concrete
action this verdict called for —
adding `speech` to `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts`'s
`DESKTOP_ONLY_NAMESPACES` (was absent — a live, unclassified gap; see
[`tasks/TASK-007-speech-add-desktop-only-namespace.md`](./tasks/TASK-007-speech-add-desktop-only-namespace.md)) —
is done. Treat the severity/description below as the pre-investigation
framing, kept for history rather than as a description of current behavior.
```

`specs/backend-go/bugs/missing-v3/README.md`'s "Bug index" table (`README.md:86-90`, verbatim current row) also references BUG-006 and would go stale alongside it:

```markdown
| ID | Title | Severity | Kind |
|----|-------|----------|------|
| [BUG-006](./BUG-006-speech-models-channels-not-implemented.md) | `speech.models.*` (3/3 methods) not implemented — blocks mobile app voice-dictation setup against a remote target | Medium | Full gap (capability) |
```

Update this row's **Kind** column from `Full gap (capability)` to `Resolved — will not implement (frontend suppressor)`, and adjust the Title cell to stop reading as an open capability gap, e.g.:

```markdown
| [BUG-006](./BUG-006-speech-models-channels-not-implemented.md) | `speech.models.*` (3/3 methods) — investigated, will not be ported to backend-go; resolved via `DESKTOP_ONLY_NAMESPACES` | Medium | Resolved — will not implement (frontend suppressor) |
```

(Leave `README.md`'s "11 real, confirmed gaps filed" summary line, `:30`, and its `BUG-004`–`BUG-006` range reference, `:165`, as historical framing of what this pass *found* — this task only updates the status-facing "Bug index" row, not the retrospective narrative text describing the original investigation.)

## Verify

No code to build — this is a markdown-only change. Confirm the edited file still parses as valid markdown (no broken link syntax) and that the new status line does not contradict this same file's "Missing channels" table or "References" section below it (neither needs to change — they describe the original problem accurately regardless of the resolution).
