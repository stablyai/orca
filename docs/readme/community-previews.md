# Orca Community previews

Enable **Community previews** in Settings → Experimental. Custom builds with a recorded manifest also show Community and a clickable **Custom** badge.

## Browse changes

**Proposals** lists open pull requests from `stablyai/orca`. These proposals are not in official Orca yet. Explore, Saved, and Viewed share one catalog. Cards show author-linked images, saved state, and whether the source changed since the last visit. Areas are inferred from titles, not maintainer-assigned labels.

The catalog refreshes asynchronously, with two concurrent GitHub requests, paged fetching, cached results, cancellation, and rate-limit feedback. The UI requests 12 results at a time. Choose an existing GitHub CLI account on the selected host for authenticated limits. Orca stores the account name, not another copy of its token.

**Activity** shows source merge outcomes, weekly submissions in UTC, authors, and review coverage. Public repository affiliation is labeled separately from verified maintainer roles. Unknown roles, incomplete review histories, partial cohorts, and missing checks stay unknown. A merge does not prove review approval or release inclusion.

**Changelog** shows published GitHub releases and links to their official notes.

## Inspect a proposal

Open a card for a full-width image preview, pinned source diff, current-head checks and reviews, an AI conversation, and captured history. The image viewer supports previous/next buttons, arrow keys, thumbnails, zoom, fit, and copy.

AI conversations use Orca's existing native chat in the selected workspace and its execution host. They start in Ask mode. Public PR text is untrusted source material. Evidence requests prepare real agent messages for more images, test plans, source updates, and risk investigation. They do not manufacture screenshots, execute tests, or post to the PR author automatically. AI review is not a safety guarantee.

Source captures and evidence have SHA-256 records. Personal saves, visits, linked chats, candidate states, and release proofs persist on the chosen host. Open captured evidence from History to verify its recorded digest.

## Prepare a Custom candidate

Selection is separate from installation. The Custom manager shows changes recorded in the running build, selections for the next build, current source/check/review signals, and feature history.

1. Select up to 12 open PRs.
2. Prepare a source plan. It pins official main, selected heads, and the existing Custom source and changes. Unknown local patches block replacement until the build has a source manifest.
3. Install `.github/workflows/community-candidate.yml` on your own fork's default branch once. Choose the trusted workflow ref in Orca. Its bytes must match the expected workflow digest.
4. Review the confirmation. Dispatch creates a separate review branch and pinned workflow tag in your fork. It can use billed GitHub Actions minutes. It never edits another author's branch.
5. The disposable macOS runner merges the pinned public sources, records heuristic risk indicators, installs dependencies, checks the combined code and dependency security, and attempts an unsigned build. It receives no user signing keys or provider credentials.
6. Refresh the run status and download its artifact for inspection. Orca stages the zip without extracting or running it. It records a local SHA-256 digest and compares GitHub's artifact digest when available. The receipt and links remain in Candidate history.
7. A trusted publisher must sign and qualify the resulting build before installation. **Choose a compatible local build** uses Orca's existing desktop updater, schema compatibility checks, and code-signature requirement. The Community workflow does not bypass those checks. Mobile and remote viewers do not replace the desktop app.

A completed build, an artifact digest, or a heuristic scan does not prove that code is safe. Failed builds may still have diagnostic artifacts. Inspect their conclusion and logs.

The informational Custom manifest does not establish profile isolation or synchronization. A publisher must preserve its own app identity, startup profile boundary, updater policy, CLI ownership, and encryption identity. Do not launch two writable Orca backends against the same profile.

## Track official inclusion

Official progress shows observed facts for the exact source head. It does not predict an approval date. Release verification compares the PR's merge commit with a published official release commit. A merged PR stays separate from a verified release proof. Existing local patches are not silently removed.

## Development verification

The owner-layer tests cover durable personal state, source-version boundaries, evidence integrity, incomplete checks and diffs, and response-image grouping. Component fixtures support desktop and phone layouts. An optional loopback-only proof endpoint feeds the Community fixture from production RPC handlers; no sample backlog is shipped.

GitHub-specific operations stay in Community modules. Older paired runtimes must be updated before using the new Community RPC methods. General Orca workspaces and native chat remain independent of the experiment.
