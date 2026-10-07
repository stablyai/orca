# Proposal

## Why

Folder group import silently takes a different path when the selected folder is a Git repository, and nested discovery silently excludes directories matched by `.gitignore`. Users cannot distinguish these decisions from a broken importer and may remove repository metadata or ignore files to make the option appear.

## What Changes

- Add an explicit `Import folder as group` entry to Add Project that reuses the existing picker and scanner. Only this intent pauses on Git-root classification to explain why grouping is unavailable; ordinary `Browse folder` single-repository import remains uninterrupted.
- Show an inline summary of observed folder exclusions, with expandable paths and the effective `.gitignore` rule and source file when applicable.
- Distinguish policy exclusions from scan boundaries, cancellation, timeout, and unreadable directories, including when no repositories are found.
- Publish bounded, optional scan diagnostics from the execution host; handle older hosts without inventing exclusion details.
- Keep discovery, import, grouping, host routing, and filesystem contents unchanged. Do not add rescan controls, ignore overrides, a new import mode, or guidance to delete `.git` or `.gitignore`.

## Capabilities

### New Capabilities

- `folder-group-import-explanations`: Visible, factual explanations for selected-path classification, observed directory exclusions, and incomplete nested repository discovery across local and remote Add Project flows.

### Modified Capabilities

None. The project currently has no main OpenSpec capability specs.

## Impact

- Scanner and filter policy reporting in `src/main/project-groups/nested-repo-discovery.ts` and `nested-repo-scan-rules.ts`; existing discovery decisions remain authoritative.
- Additive result metadata in `src/shared/project-group-types.ts`, carried through existing IPC progress/final responses and `projectGroup.scanNested` RPC without changing request options.
- Existing Add Project flows and repository-review UI, including local folder browsing, SSH path selection, paired runtime paths, zero-result fallbacks, and `NestedRepoScanLimitNotice`.
- Focused scanner, matching, compatibility, renderer, and hidden Electron UI coverage; localized and accessible inline copy using existing design-system primitives.
- No new dependencies or changes to folder workspace attachment. The existing `tests/e2e/folder-setup.spec.ts` modification from earlier verification is separate work, not implementation of this proposal.
