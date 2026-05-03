# Orca Privacy Notice

Version: 1.0 — Last updated: 2026-05-02

Orca is a local desktop application for running CLI coding agents across git worktrees. This document describes the anonymous product-usage telemetry we collect in packaged Orca builds, what we never collect, and how to opt out.

## Summary

- **Anonymous.** Telemetry events are keyed by a locally-generated UUID (`install_id`). No account, email, IP, or user name is collected.
- **No content.** We never transmit file contents, prompts, agent output, terminal output, repo names, branch names, URLs, paths, or commit messages. The validator fails closed on anything outside the typed event schema.
- **Cohort-aware defaults.** New installs ship with telemetry on and a dismissible first-run disclosure. If you upgraded into the first telemetry release, telemetry starts off and a banner asks for explicit opt-in.
- **Always off when:** `DO_NOT_TRACK=1`, `ORCA_TELEMETRY_DISABLED=1`, or any common CI environment variable is set (e.g. `CI`, `GITHUB_ACTIONS`).
- **Dev builds never transmit.** `pnpm dev`, contributor checkouts, and third-party forks do not carry the build-identity constant that gates transmission, so events only appear in a local console mirror.

## What we collect

Every event carries these common properties:

- `app_version` — the Orca version string.
- `platform` — `darwin` / `win32` / `linux`.
- `arch` — CPU architecture (`arm64`, `x64`, …).
- `os_release` — coarse OS release string (e.g. `25.3.0`). No hostname.
- `install_id` — anonymous UUID v4. Stable across launches, regenerable from Settings → Privacy.
- `session_id` — new UUID per app launch; does not persist.
- `orca_channel` — `stable` or `rc`. Present only on official release builds; dev builds never transmit.

The events we send (7 in total — 8 literal names, counting `telemetry_opted_in` / `telemetry_opted_out` as one matched pair):

### Lifecycle

- `app_opened` — fires when the main window finishes loading. No custom properties. Daily/weekly/monthly active users are derived server-side from distinct `install_id`s with an `app_opened` in the window; we do not emit a dedicated `daily_active_user` event.

### Repos and workspaces

- `repo_added` — `method`: `folder_picker` / `clone_url` / `drag_drop`. Never the repo URL, repo name, or path.
- `workspace_created` — `source`: entry-point enum (`command_palette` / `sidebar` / `shortcut` / `drag_drop` / `unknown`); `from_existing_branch` (bool). Never the branch name or base branch.

### Agents

- `agent_started` — `initial_agent_kind` (enum — `claude-code` / `codex` / `gemini` / `copilot` / `cursor` / `opencode` / `aider` / `amp` / `other`); `launch_source` (`command_palette` / `sidebar` / `tab_bar_quick_launch` / `task_page` / `new_workspace_composer` / `workspace_jump_palette` / `shortcut` / `unknown`); `request_kind` (`new` / `resume` / `followup`). This event means "what Orca launched after confirmed session creation," not a later shell-title inference. No model details, no prompt content.
- `agent_error` — `error_class` (closed enum of known error types); `agent_kind`; optional `error_name` drawn from a closed whitelist of error class names. Enum-only: no raw error message, no stack trace, no free-form identifiers. Per-incident error context lives only in a local diagnostic trace file on your machine; it reaches Orca only if you explicitly share a diagnostic bundle.

### Settings

- `settings_changed` — `setting_key` (whitelisted enum, scoped to a small set of feature-flag and UX-preference toggles); `value_kind`: `bool` / `enum`. Never the raw value of a free-form setting.

### Privacy controls

- `telemetry_opted_in` / `telemetry_opted_out` — fires exactly once at the moment of the change. `via`: `first_launch_banner` / `first_launch_notice` / `settings`. Environment-variable and CI overrides do not fire these events — they disable transmission at runtime without changing your stored preference.

## What we never send

- No file paths, repo names, branch names, URLs, commit messages, or current working directory.
- No agent prompts, responses, or terminal contents.
- No raw error messages, no stack frames, and no free-form identifiers. `agent_error` is enum-only (`error_class` + `agent_kind`, plus an optional whitelisted `error_name`). Per-incident error context stays in a local diagnostic trace file and reaches Orca only if you explicitly share a diagnostic bundle.
- No user account information (Orca has no account system).
- No precise geoip. PostHog's project-level "Discard client IP data" is on; country is the only geographic signal derived from the request, and we do not populate `$ip` ourselves.
- No person-profile materialization on the vendor side. Every event is captured with `$process_person_profile: false` so no profile is created against the anonymous `install_id`.
- No free-form strings from any UI input. Every transmitted string property is either an enum, a UUID, or a bucketed/versioned constant.

Runtime enforcement: a single `track(event, props)` wrapper with a TypeScript-typed event map and a runtime Zod validator. Events not in the map never compile; properties outside the declared shape are dropped at runtime with a warning.

## How to opt out

You can disable telemetry in three ways. Any one of them is sufficient; they compose.

1. **In the app.** Settings → Privacy → toggle "Share anonymous usage data" off. The change is immediate and persistent.
2. **`DO_NOT_TRACK=1`** — community-standard environment variable. Disables transmission for that launch. Unsetting it restores your stored preference on the next launch.
3. **`ORCA_TELEMETRY_DISABLED=1`** — Orca-specific kill switch with the same semantics as `DO_NOT_TRACK`.

CI environments are auto-detected (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `TRAVIS`, `BUILDKITE`, `JENKINS_URL`, `TEAMCITY_VERSION`) and do not transmit.

### Residual flush on opt-out

When you flip telemetry off, events captured up to roughly 10 seconds before the toggle may still be transmitted in the final SDK batch (this is PostHog Node's flush interval). Subsequent events will not.

## Where the data goes

- **Vendor:** PostHog Cloud (`us.i.posthog.com`), **United States** region.
- **Project configuration:** session recordings disabled; precise geoip disabled (country-only); person-profile creation suppressed per event (`$process_person_profile: false`) so no profile is materialized for an anonymous `install_id`.
- **Retention:** PostHog Cloud's plan-level default. At the time of this document, the free tier retains event data for 1 year, with cold-storage thereafter per PostHog's pricing page. Paid tiers extend this. We do not set a custom retention window.
- **Access:** project membership is restricted to the telemetry owner and a single backup.

## Resetting or stopping your anonymous data

Three paths are available to you directly:

- **Reset anonymous ID** in Settings → Privacy rotates your `install_id` prospectively. Subsequent events carry a fresh UUID; events emitted before the rotation remain associated with the old UUID and are not linkable to the new one.
- **Opt out** (Settings → Privacy, `DO_NOT_TRACK=1`, or `ORCA_TELEMETRY_DISABLED=1`) stops transmission entirely from the next event onward.
- **Retention** is PostHog Cloud's plan-level default (see above); old events age out on that schedule without any action on your part.
