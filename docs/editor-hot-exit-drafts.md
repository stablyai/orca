# Editor Hot Exit Drafts

## Problem

Intentional app restarts currently ask the renderer to save dirty editor files before quitting. That is the wrong default for restart/update: it silently chooses "Save" for the user, and update install currently proceeds even if that save path fails. Users with dirty floating markdown buffers can lose work when the app exits before the debounced session writer captures the latest draft state.

## Goals

- Preserve dirty markdown/editor buffers across manual restart and update restart without prompting.
- Restore those buffers as dirty editor tabs, not as saved disk content.
- Keep normal window-close behavior unchanged.
- Abort restart/update if Orca cannot capture the dirty draft backup.
- Support floating workspace and runtime-owned editor files whose IDs are rebuilt on hydrate.

## Non-Goals

- No change to the PTY daemon lifecycle.
- No forced save of dirty files to disk.
- No restore of transient diff/conflict editor views.
- No cross-device draft sync or provider-specific behavior.

## Design

Extend `PersistedOpenFile` with an optional `dirtyDraftContent` string. `buildEditorSessionData` will receive `editorDrafts` and attach `dirtyDraftContent` only when the open file is edit-mode, dirty, and has an in-memory draft. Clean files stay compact and older sessions continue to parse.

Add `editorDrafts` to `WorkspaceSessionSnapshot` and `SESSION_RELEVANT_FIELDS`. The normal debounced session writer will therefore keep the backup reasonably fresh while the user edits, but restart/update will not rely on the debounce.

On hydrate, `hydrateEditorSession` will use the final restored editor file ID, including owner-qualified floating/runtime IDs, to rebuild `editorDrafts` and mark that `OpenFile` dirty when `dirtyDraftContent` is present. This keeps the restored tab in the same unsaved state the user left it in.

Replace restart/update dirty-save prep with a hot-exit prep event. The editor autosave controller will claim the event, flush pending rich-editor changes into `editorDrafts`, quiesce any pending autosave timers, validate that every dirty edit-mode file has a draft, synchronously write the full workspace session through `session:set-sync`, and reject on failure. Preload will abort both manual restart and update install when the backup rejects.

Normal close prompts remain owned by the existing window-close dirty-file guard. Hot exit only applies to intentional restart/update paths after `ORCA_APP_RESTART_STARTED_EVENT` or `ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT` marks the close as intentional.

## Edge Cases

- Floating/runtime files: hydrate writes drafts under the rebuilt owned editor ID.
- Same file open in multiple owners: each persisted entry carries its own draft content.
- Dirty non-edit files: hot exit rejects, because restart does not restore transient editor views.
- Missing draft content for a dirty edit file: hot exit rejects instead of risking data loss.
- Pending autosave: hot exit flushes editor state and cancels pending timers before backup; it does not force a disk save.
- Old sessions: files without `dirtyDraftContent` hydrate as clean, preserving current behavior.
- SSH/runtime files: the backup is local app-owned state; it does not assume local filesystem writes.

## Test Plan

- Schema/type tests accept and round-trip `dirtyDraftContent`.
- Workspace-session tests prove dirty edit files include drafts and clean files do not.
- Patch/subscriber tests prove `editorDrafts` changes persist editor session data.
- Hydration tests prove dirty floating/runtime-owned files restore with the rebuilt ID and draft content.
- Restart prep tests prove hot exit dispatches the new event, aborts on backup failure, and no longer dispatches the dirty-save-to-disk event.
- Autosave-controller tests prove hot exit flushes drafts, rejects unsupported dirty files, and calls `session.setSync`.

## Lightweight Engineering Review

This design matches the standard hot-exit UX: restart/update becomes no-prompt and no-forced-save, while normal close still asks the user to choose. The main risk is session size, but dirty drafts are bounded by open editor buffers and are already resident in renderer memory. The stronger safety constraint is to reject restart/update when a dirty file cannot be represented in the session, which prevents the update path from continuing through known data-loss conditions.

## Independent Review Resolution

- Patch writes must treat `editorDrafts` as an editor-session dependency, otherwise ordinary debounced edits can miss draft content. The implementation updates both `SESSION_RELEVANT_FIELDS` and `buildWorkspaceSessionPatch`.
- Hot-exit and `beforeunload` both write full workspace sessions. This is safe only because the shared `buildWorkspaceSessionPayload` path is draft-aware, so the later terminal-buffer flush cannot overwrite draft backups with clean editor entries.
- Empty-string drafts are valid user content and must be tested with `!== undefined` checks.
- Dirty non-edit files are rejected on hot exit because restart does not restore transient editor views; this behavior is covered explicitly for unstaged diff tabs.
