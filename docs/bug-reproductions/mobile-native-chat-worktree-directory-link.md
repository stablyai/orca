# Mobile native chat: existing worktree directory link

Investigated on 2026-10-29 in `debug-mobile-worktree-chat-link`, based on `cb21824bd956ef6fec14afba6dfe65c735ee8b9f`. Changes are limited to this debugging worktree. The plugin-category worktree was only queried through the read-only Orca CLI.

## Original message and observed error

The original assistant reply was:

```markdown
Handed off via orca-cli to **gpt-6.1-sol, high effort** in the [Orca worktree](/Users/jinjingliang/Documents/projects/orca/improve-plugin-category-display).

Agent session: `codex_480c565e_4e44_45dc_a135_5f5b30c070ad`. It received the changes, reference screenshot, and remaining validation status.
```

The supplied iPhone screenshot shows this inline error after tapping **Orca worktree**:

```text
Couldn't open /Users/jinjingliang/Documents/projects/orca/improve-plugin-category-display
```

Source workspace:

```text
d11c8322-62d2-4992-9091-9706d68c5935::/Users/jinjingliang/Documents/projects/orca-plugins/improve-plugin-category-display
```

Destination workspace:

```text
48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/improve-plugin-category-display
```

`orca worktree show --worktree id:<destination> --json` confirmed the destination is registered, on branch `AmethystLiang/improve-plugin-category-display`, with the source workspace recorded as its parent.

## Confirmed cause

The href is a bare absolute directory path. It correctly enters the file-path routing pipeline, but mobile treated every directory as an unsuccessful file open, including a known workspace root.

The actual path is:

1. `mobile/src/components/mobile-markdown-tree.ts` parses the Markdown link without losing its href.
2. `mobile/src/components/mobile-markdown-inline.tsx` calls `openMarkdownHref`, which uses `routeMarkdownHref` and shared `routeNativeChatHref` to dispatch the path to `onOpenFile`.
3. `mobile/src/session/use-mobile-file-tap-handlers.ts` calls `openMobileNativeChatFileTap`, resolving chat paths from the source workspace root without borrowing terminal cwd.
4. `mobile/src/session/mobile-file-tap-open.ts` requests `files.resolveTerminalPath` with `crossWorkspace: true`.
5. `src/main/runtime/terminal/terminal-path-resolver.ts` uses the existing host-scoped `resolveKnownWorkspaceFileTarget` lookup to identify the destination workspace across repositories, then stats its directory.
6. Before the fix, `existingFileTapResolution` returned a result only when `resolved.exists && !resolved.isDirectory`. It discarded the successful directory resolution. `reportOpenFailure` then invoked the hook's existing `Couldn't open ${pathText}` callback.

A read-only request to the running installed host, using the exact source ID and target href, returned:

```json
{
  "worktree": "48e366bb-2436-46a9-bb37-10ace25ada5f::/Users/jinjingliang/Documents/projects/orca/improve-plugin-category-display",
  "relativePath": "",
  "absolutePath": "/Users/jinjingliang/Documents/projects/orca/improve-plugin-category-display",
  "exists": true,
  "isDirectory": true
}
```

This confirms the failing branch is mobile's directory filter. The host found the existing target outside the source worktree; this was not a missing directory or a failed handoff.

Desktop comparison: `use-native-chat-file-link-click.ts` routes through `resolveNativeChatFileLink` and `openDetectedFilePath`. That opener already uses `resolveKnownWorktreeRootPathLink` and `activateAndRevealWorktree` to navigate known worktree roots.

## Fix

The mobile opener now accepts an existing directory only when the host confirms an exact workspace root (`relativePath === ''` and a nonempty workspace ID), and the caller supplies workspace navigation. Unknown external directories, ordinary subdirectories, missing roots, and malformed workspace IDs remain unsuccessful opens.

Both terminal and native-chat tap handlers supply navigation using the existing `mobileSessionRouteTarget`, `hostStackRouteHref`, and `useWorkspaceRouteHandoff`. This opens the resolved workspace session while preserving the paired host and any SSH/runtime execution-host route. It does not invent a new href scheme, treat directories as file previews, or create another workspace. Folder workspace IDs are supported without assuming a git worktree.

Pending opens are invalidated when the client, host, or source workspace changes, or the source screen blurs or unmounts, in addition to the existing newer-tap and active-tab checks. This prevents a delayed response from navigating an ID resolved on the previous host into the newly selected host or overriding navigation after the user leaves the source screen.

The host also checks confirmed in-workspace directories for an exact registered nested workspace root. This lookup stays scoped to the source execution host and only runs for cross-workspace requests; ordinary file taps and legacy requests keep their existing resolution behavior. An exact source root remains attached to the selected workspace.

The RPC request and response contracts are unchanged. Older hosts that cannot identify a cross-workspace root retain the existing failure behavior rather than navigating to a guessed workspace.

## Validation

All tests and commands used `ORCA_BACKGROUND_LAUNCH=1`.

- The regression test parses the exact first paragraph of the original Markdown through the real mobile parser and href router, then runs the real tap handlers and file opener with an RPC-boundary response matching the live host. It failed before the fix because workspace navigation was never called.
- Focused mobile suite: 46 tests passed in five files. Covers the exact cross-repository target, runtime and SSH route preservation, folder workspace IDs, unknown/subdirectory/missing/malformed directory results, ordinary files and line references, artifact previews, headless-host fallback, active-chat changes, and delayed responses after a host change.
- Host/shared suite: 48 tests passed in four files. Covers workspace directory/root resolution, host-scoped ownership, existing file behavior, cross-platform href/path handling, and compatibility with requests that do not opt into cross-workspace resolution.
- The patched mobile opener was also run directly against the live host's real response. It called the workspace navigation callback with the exact destination ID, without requesting file open, preview, browser open, or file-tab activation.
- Mobile app and test typechecks passed.
- `pnpm check:changed --maxWorkers=2` passed all 14 selected checks.

The review follow-up reproduced delayed navigation after blur/unmount and rejected nested workspace roots before fixing them. The updated focused mobile suite passed 48 tests, and the host/shared suite passed 55 tests. New cases cover navigation after leaving and refocusing the source screen, nested git and folder workspace roots, Windows paths, ordinary subdirectories/files, and legacy requests without cross-workspace resolution.

The follow-up `check:changed` run passed 22 of 23 checks, including the broader affected unit tests. Its only failure was four type errors in unchanged structured-agent test/support files: missing `legacySessionTabIds` in two record-store calls and string command resolvers where `StructuredAgentCommand` is required in two fixtures. Both mobile typechecks passed.

Focused commands:

```bash
ORCA_BACKGROUND_LAUNCH=1 pnpm -C mobile test src/session/use-mobile-file-tap-handlers.test.ts src/session/native-chat/visual/mobile-native-chat-open-file.test.ts src/session/mobile-file-tap-open.test.ts src/components/markdown-href-routing.test.ts src/navigation/workspace-route-handoff.test.tsx --maxWorkers=2
ORCA_BACKGROUND_LAUNCH=1 pnpm test src/main/runtime/orca-runtime-files-terminal-path-resolution.test.ts src/shared/runtime-workspace-file-owner.test.ts src/shared/native-chat/native-chat-href-routing.test.ts src/main/runtime/orca-runtime-files-terminal-link-host-translation.test.ts --maxWorkers=2
ORCA_BACKGROUND_LAUNCH=1 pnpm -C mobile typecheck
ORCA_BACKGROUND_LAUNCH=1 pnpm -C mobile typecheck:tests
ORCA_BACKGROUND_LAUNCH=1 pnpm check:changed --maxWorkers=2
```

The iPhone failure is evidenced by the supplied screenshot. The fix was validated in code and against the real host; it has not been installed or physically retested on that iPhone. No visible desktop app or simulator was launched.

## Diagnostic messages added

**None.** No production debug logs, toasts, banners, or chat messages were added. The existing `Couldn't open ${pathText}` error remains for unresolved or unsupported paths. The live repro printed its selected host-resolution fields and navigation callback ID to the agent's shell only; it did not modify the app or chat transcript.
