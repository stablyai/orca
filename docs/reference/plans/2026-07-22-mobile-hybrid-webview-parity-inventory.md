# Mobile Hybrid WebView Feature-Parity Inventory

- **Status:** Feature ownership and adapters complete; live validation and
  gated cutover remain
- **Last updated:** July 28, 2026
- **Design:**
  [`2026-07-22-mobile-hybrid-webview-single-pr-migration.md`](./2026-07-22-mobile-hybrid-webview-single-pr-migration.md)
- **Checklist:**
  [`2026-07-22-mobile-hybrid-webview-implementation-checklist.md`](./2026-07-22-mobile-hybrid-webview-implementation-checklist.md)

> **2026-09-02 — the recent-user-gesture window described below was removed.** The
> shell no longer requires a recent native touch before a bridge capability runs: a
> scroll armed the window, so it gated nothing on a first-party page, and peer hybrid
> frameworks do not gate bridge calls this way. Gesture statements here describe the
> plan as written, not the shipped shell.

## Purpose

This inventory prevents a visually successful WebView cutover from silently
dropping behavior that currently lives in React Native routes, transport hooks,
storage, or native capability modules. Each inventory area is frozen before its
production contract or feature slice is declared complete.

The visual and interaction baseline is the mobile UI on `origin/main` at the
migration baseline. Every host-workspace route must reuse that presentation
source through React Native Web. A functionally equivalent replacement UI does
not satisfy parity.

## Ownership Rules

- The native shell owns paired identity, credentials, connectivity, recovery,
  package activation, native permissions, and store-delivered capabilities.
- The mobile web app owns host-specific workspace features that release with
  Desktop.
- Existing React Native screen, component, style, and view-model source is
  shared by the native and web runtimes. Target ownership identifies where the
  feature executes, not permission to reimplement its presentation.
- The obsolete `src/mobile-web/` validation presentation is removed. Its
  remaining modules are production bridge clients and transport state used by
  the shared React Native Web routes, not a second product UI.
- A native settings route may configure a web-owned feature when the setting
  controls native input, permission, lifecycle, or recovery behavior.
- Compatibility redirects disappear when all supported deep links route through
  the typed native-to-web navigation capability.

## Route Inventory

`QuickCommandsTabButton.tsx` is colocated under the Expo Router session folder
but is a component, not a route. It migrates with the session UI.

| Current route                                           | Current responsibility                                                             | Target owner   | Migration decision                                                                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile/app/_layout.tsx`                                | Root providers, deep links, notification routing, pairing recovery, route registry | Native shell   | Keep; replace prototype registration with production hybrid route                                                                                                                 |
| `mobile/app/index.tsx`                                  | Host list plus cross-host worktree/task/account summaries                          | Native shell   | Keep host selection and health; move host workspace summaries/actions behind host entry                                                                                           |
| `mobile/app/mobile-onboarding.tsx`                      | Notification and session-view onboarding                                           | Native shell   | Keep; update claims and default destination for hybrid workspace                                                                                                                  |
| `mobile/app/pair-scan.tsx`                              | QR/manual pairing and pre-profile connection                                       | Native shell   | Keep                                                                                                                                                                              |
| `mobile/app/pair.tsx`                                   | Pairing deep-link redirect                                                         | Native shell   | Keep                                                                                                                                                                              |
| `mobile/app/pair-confirm.tsx`                           | Pair confirmation, credential installation, connection feedback                    | Native shell   | Keep                                                                                                                                                                              |
| `mobile/app/settings.tsx`                               | Native app settings navigation and credential cleanup retry                        | Native shell   | Keep; remove Experimental prototype entry at cutover                                                                                                                              |
| `mobile/app/terminal-settings.tsx`                      | Terminal input, shortcut, font, and recovery preferences                           | Native shell   | Keep native/device preferences; expose typed values to web terminal                                                                                                               |
| `mobile/app/native-chat-settings.tsx`                   | Default session view preference                                                    | Native shell   | Keep preference; web session consumes it through shell state                                                                                                                      |
| `mobile/app/browser-settings.tsx`                       | Browser interaction preferences                                                    | Native shell   | Keep device/input preferences; web browser surface consumes them                                                                                                                  |
| `mobile/app/voice-settings.tsx`                         | Dictation model setup and host voice capabilities                                  | Native shell   | Keep permission/model lifecycle; web invokes typed audio/dictation capabilities                                                                                                   |
| `mobile/app/notifications.tsx`                          | Notification permission and preference UI                                          | Native shell   | Keep                                                                                                                                                                              |
| `mobile/app/notification-opt-in.tsx`                    | Legacy notification route redirect                                                 | Native shell   | Keep until legacy deep-link support can be retired independently                                                                                                                  |
| `mobile/app/troubleshoot.tsx`                           | Reachability, diagnostics, and recovery actions                                    | Native shell   | Keep; add package/cache/bridge recovery state                                                                                                                                     |
| `mobile/app/connection-log.tsx`                         | Connection diagnostics and support report                                          | Native shell   | Keep; add privacy-safe hybrid diagnostics                                                                                                                                         |
| `mobile/app/about.tsx`                                  | Native application identity/version                                                | Native shell   | Keep; add shell and active web build versions where useful                                                                                                                        |
| `mobile/app/h/_layout.tsx`                              | Host protocol gate and host route stack                                            | Native shell   | Keep as host security/recovery boundary; mount one production hybrid workspace route                                                                                              |
| `mobile/app/h/[hostId]/edit.tsx`                        | Paired host display name, endpoint, reconnect                                      | Native shell   | Keep because it changes paired connectivity rather than workspace content                                                                                                         |
| `mobile/app/h/[hostId]/index.tsx`                       | Worktree list, creation, actions, host workspace entry                             | Mobile web app | Complete on iOS Simulator: native and hosted mount the same `HostScreen` and pass strict screenshot parity                                                                        |
| `mobile/app/h/[hostId]/accounts.tsx`                    | Host agent-account usage and selection                                             | Mobile web app | Complete on iOS Simulator: the same screen uses typed native/web host-account adapters and passes strict screenshot parity                                                        |
| `mobile/app/h/[hostId]/tasks.tsx`                       | Host task providers, task details, mutations, workspace creation                   | Mobile web app | Complete on iOS Simulator: same route/presentation with strict native/web operations                                                                                              |
| `mobile/app/h/[hostId]/session/[worktreeId].tsx`        | Sessions, tabs, terminal, browser, native chat, files, attachments, dictation      | Mobile web app | Complete at route level on iOS Simulator: the same Session presentation passes strict screenshot parity, terminal interaction, native-chat recovery, and downstream route handoff |
| `mobile/app/h/[hostId]/agent-history/[worktreeId].tsx`  | Agent session history and resume                                                   | Mobile web app | Complete on iOS and Android emulators: same panel/list presentation, bounded opaque snapshot/preview/resume operations, scopes, search, and trusted-resume mediation              |
| `mobile/app/h/[hostId]/files/[worktreeId].tsx`          | File explorer                                                                      | Mobile web app | Complete on iOS Simulator: the same `MobileFileExplorerPanel` passes strict screenshot parity with bounded opaque directory reads and native-shell reconnect                      |
| `mobile/app/h/[hostId]/files/preview/[worktreeId].tsx`  | File, Markdown, image, editable, HTML, and Mermaid previews                        | Mobile web app | Complete on iOS Simulator for real file Preview parity; HTML remains sanitized in a hash-bound inert frame and native/hosted Mermaid use the bundled hash-authorized engine       |
| `mobile/app/h/[hostId]/source-control/[worktreeId].tsx` | Source-control hub                                                                 | Mobile web app | Complete on iOS and Android emulators: same `MobileSourceControlPanel`, including Session-origin changed-file handoff                                                             |
| `mobile/app/h/[hostId]/review/[worktreeId].tsx`         | Diff review and comments                                                           | Mobile web app | Complete on iOS and Android emulators: same review presentation and virtualization; standalone controls verified independently                                                    |
| `mobile/app/h/[hostId]/history/[worktreeId].tsx`        | Legacy source-control history redirect                                             | Mobile web app | Complete: provider-neutral compatibility redirect preserves the history segment during rollout                                                                                    |
| `mobile/app/h/[hostId]/pr/[worktreeId].tsx`             | Legacy pull-request redirect                                                       | Mobile web app | Complete: provider-neutral compatibility redirect preserves the pull-request segment during rollout                                                                               |
| `mobile/app/hybrid-prototype.tsx`                       | Retired Option B prototype                                                         | Removed        | Production `/hybrid` owns the hosted route; the Experimental Settings entry remains until cutover                                                                                 |

## RPC and Subscription Inventory

The current mobile application has 148 literal RPC method references, 32
dynamic call sites, and seven literal subscriptions. The method-name authority
is `src/main/runtime/mobile-rpc-allowlist.test.ts`: it scans literal
`sendRequest`, `subscribe`, and `method` values, adds the reviewed dynamic and
stream-cleanup lists, then proves that every result is both registered and in
`MOBILE_RPC_METHOD_ALLOWLIST` in `src/main/runtime/runtime-rpc.ts`.

The literal subscriptions are `accounts.subscribe`, `browser.screencast`,
`nativeChat.subscribe`, `notifications.subscribe`,
`runtime.clientEvents.subscribe`, `session.tabs.subscribe`, and
`terminal.subscribe`. Their explicit cleanup methods remain part of the same
allowlist contract.

| Capability family                | Current boundary                                                                      | Production bridge rule                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Workspace and runtime            | Worktree snapshots/mutations, runtime navigation and client events                    | Named workspace/navigation adapters; bind delayed results to host, build, workspace, and shell session                  |
| Sessions and agents              | Session/tab lifecycle, agent start/stop/respond, native-chat stream                   | Named session operations; preserve Desktop permission, question, input-lease, and subscription cleanup authority        |
| Terminal                         | Terminal reads/mutations plus binary `terminal.subscribe`                             | Dedicated terminal adapter described below; never expose a generic streaming RPC                                        |
| Files, diffs, and source control | File reads/writes/search, diff/review state, Git mutations and computed method unions | Bounded file/source-control operations; Desktop retains path validation, Git capability checks, provider and host scope |
| Tasks and providers              | Task queries/mutations and computed GitHub/GitLab review operations                   | Provider-neutral task/provider operations with explicit provider checks on Desktop                                      |
| Browser                          | Screencast plus computed back/forward/reload/dialog operations                        | Named browser operations with bounded stream cleanup and no arbitrary URL navigation through the privileged WebView     |
| Accounts and settings            | Account snapshots/subscriptions and computed Claude/Codex selection                   | Named account/settings operations; no credentials or secure-store material enter results                                |
| Notifications                    | Enrollment/preferences and notification subscription                                  | Enrollment remains native-owned; only typed route events cross to the page after host selection                         |
| Prototype package delivery       | Computed manifest/chunk callbacks                                                     | Remove at cutover; production package RPC is separate from the capability bridge                                        |

Dynamic Git mutations, file-preview methods, browser controls,
GitHub/GitLab task and review mutations, account selection, agent-session
creation, and streaming cleanup are already enumerated by the allowlist test.
The production operation ledger is composed rather than copied: the shared
operation registry supplies the exact capability/operation pairs, the
production grant list supplies request/response/concurrency/rate limits, shared
schemas supply payload/result shapes and stable errors, and the named native
execution adapters supply authorization and cleanup. A focused gate requires
every registered operation to have exactly one production grant and rejects
generic `rpc.call` / native `invoke`. This audit removed 12 registry-only
operations that had no production grant or caller, including direct picker,
clipboard-read, workspace-create, session-restore, and duplicate review/list
surfaces.

| Execution boundary                 | Topology and authorization rule                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted workspace operations        | Use the selected paired host's logical `RpcClient`; Relay/Direct changes transport only. Desktop resolves opaque page authority and retains native, WSL, SSH, provider, Git, filesystem, and terminal ownership. |
| Native capabilities and navigation | Execute only in the active native shell session with the operation-specific gesture, permission, foreground, and route checks. They never forward through Desktop RPC.                                           |
| Package delivery                   | Uses the paired Desktop package methods over Direct or Relay, independent of the workspace execution provider. The mobile downloader and native cache verify identity and bytes before activation.               |
| Subscriptions and streams          | Bind to the current host/build/shell/workspace authority; every family has an explicit cleanup/cancel path and reconnect resnapshot rule.                                                                        |

The Tasks route has begun that per-operation migration without changing its
presentation. Strict native/web operations now own bootstrap state,
repositories, Linear context, GitHub repository identity, resume/default/project
preferences, setup trust, clipboard, haptics, and external URLs. Repository
arguments are opaque page handles translated only by the shell broker. Branch
search, SSH state/connect, agent detection, and repository-hook reads reuse the
New Workspace contract. Bounded GitHub work-item list/count, GitLab work-item
list/todos, and Linear issue list/search operations now use the same strict
boundary. GitHub labels/assignable users/work-item details, GitLab work-item
details, and Linear issue/comment details are also bounded named reads. GitLab
provider targets are shell-issued opaque handles; real host/path pairs never
enter the page. GitHub Project discovery, view listing, pasted-reference
resolution, table snapshots, row details, labels, assignable users, and issue
types are strict reads as well. Native retains the validated whole-table
snapshot, while the page reconstructs it from bounded pages behind opaque
single-use continuations. Project item title/body/state, issue comments,
labels/assignees, fields, and issue types now use opaque row targets with a
fresh authoritative table/field revalidation before each write. Project PR
thread resolution, replies, conversation comments, reviewer requests, check
reruns, and merge additionally revalidate an opaque Orca repository handle
against the fresh row slug. Project check refresh, viewed-file state, file
contents, and inline comments now use a separate named boundary with the same
fresh row/repository revalidation. Each file-content side is capped at 256 KiB,
the operation response at 600 KiB, and page target/repository handles are
removed before Desktop RPC. Non-Project GitHub/GitLab status and metadata writes
now use revocable opaque item targets and fresh provider-detail revalidation.
Top-level comments, reviewer requests, thread resolve/reopen, inline replies,
and GitHub/GitLab merge use the same opaque authority. Non-Project GitHub check
refresh/reruns, viewed-file state, file contents, and inline comments cross a
separate strict boundary. The page supplies no repo, PR number, SHA,
pull-request node ID, old path, or file status; the shell reloads current PR
details, validates exact file membership, and derives those identities before
Desktop RPC. Each file-content side is capped at 256 KiB and the response at
600 KiB. Linear connection, workspace selection, state updates, comments,
issue reads, and top-level/subissue creation now use named operations with
fresh native issue authority. GitHub/GitLab issue creation receives only an
opaque repository target. Sparse-preset list/save and final workspace creation
reuse the strict New Workspace boundary; the shell revalidates provider
identity and PR/MR base data, preserves sparse checkout and host warnings, and
returns only an opaque workspace handle. The host-only router now mounts those
adapters behind the unchanged `tasks.tsx` route. Host 34 on the iPhone 17 Pro
Simulator rendered the existing workspace and Tasks screens, exercised GitHub
query refresh/error handling, provider selection, Linear setup, back
navigation, rotation, and background/foreground without `invalid_request` or a
parallel presentation. Bootstrap settings, repository rows, GitHub sources,
and classified errors are explicitly projected so Jira and unrelated Desktop
settings, host-only repository metadata, origin candidates, and raw error
classification never cross the bounded page contract. Physical-device,
Android, topology, accessibility, destructive-mutation, and provider-authenticated
evidence remain in the cross-cutting gates.

The existing `MobileBrowserPane` is now shared by the native and hosted session
routes through named operations rather than copied presentation. Hosted browser
authority is an opaque shell-session handle, screencast frames are assembled
from bounded 128 KiB chunks, and typed input, dialog, navigation, reload,
Back/Forward, and navigation-state paths pass focused tests. A single-current-
runtime iOS Simulator fixture also passes create, two navigations, Back,
Forward, Reload, rotation, close/reopen, page text insertion, and Tab-key focus
movement. Android, physical-device, topology, performance, and adversarial
validation remain in the cross-cutting gates.

The native-chat and agent-state slice also reuses the existing session,
`MobileNativeChatOverlay`, `MobileNativeChatView`, composer, message,
permission, and question presentation. The hosted route injects
`HostSessionNativeChatOperations`; native routes inject the native adapter.
Named `read`, `subscribe`, `sendMessage`, `respond`, `stop`, `fileSearch`,
`openFile`, and `readability` operations replace direct transport dependencies
without adding a generic RPC or native-call path.

Session snapshots expose bounded agent state, agent type, tool name/input,
interactive prompt, last assistant message, interruption state, launch hint,
and an opaque chat-session handle. They explicitly omit pane keys, terminal
handles, workspace and connection IDs, orchestration history and IDs, provider
session IDs, and transcript paths. The shell binds that opaque handle to the
exact native workspace, tab, terminal, agent, provider session, and transcript;
synchronization revokes handles that disappear or change, and client/broker
replacement clears the authority.

Current Desktop mobile responses already clip tool-call input. The native
WebView broker now independently normalizes it before schema parsing and
delivery to a 4,000-character, 100-node, 20-item, five-level budget with
128-character keys and cycle handling. This preserves supported question,
command, and file inputs while bounding older-host or adversarial structures
before response serialization.

Before every chat mutation, native reloads `session.tabs.list` and verifies
that complete identity. A mismatch revokes the handle before any terminal
write. Mutation delivery is `accepted`, `rejected`, or `unknown`; logical
Relay/Direct cutover and physical acknowledgement loss both become `unknown`
so hosted code cannot blindly replay a potentially delivered message. The
existing stop behavior still sends two Escape operations 80 ms apart and
cancels the delayed second operation on lease loss, route/session change,
operation replacement, or unmount. Native mode retains
`files.searchPaths` with the bounded legacy `files.list` fallback, while hosted
mode uses bounded server-side search. Automated projection, authority,
subscription, operation, adapter, and source-binding tests pass. Host 37 also
passes existing-history replay, composer send and streamed response, stop
delivery, file search and mention selection, tab switching,
background/foreground, and cold app reconnect in the unchanged UI using hosted
build `895357c5…`. The Codex transcript records
`Conversation interrupted`; deterministic timestamp ordering and Host 37 build
`64ae13e9…` now prove that equal-or-newer interrupted transcript evidence clears
the stale hook-derived working indicator. A real Claude `AskUserQuestion` also
rendered the unchanged hosted card, selected Beta, and returned `RECEIVED Beta`
to the agent. Structured prompts suppress permission/question heuristics until
they clear, including after an accepted answer.

Classic SSH transcript authority is now adapter-complete below that same UI.
The audit found that `nativeChat.readSession` and `subscribe` opened the
provider's transcript path through Desktop `node:fs`. A shared
`TranscriptFileSource` keeps local behavior intact and routes SSH reads through
bounded 64 KiB provider ranges. Runtime lookup requires the exact current
terminal, worktree, connection, agent, provider session, and transcript; loss
returns unavailable without a local fallback, and reconnect reacquires the
provider. A real Docker Linux sshd journey through isolated Electron and an
independent paired runtime client passes hook publication, initial read,
disconnect failure, and appended-message recovery. Durable actual-WKWebView
presentation, remote terminal mutation, retained `Reconnecting…` chat, PTY
reattachment, and appended native-chat rendering now pass on SSH. Live
ambiguous delivery remains open. A
deterministic protocol-compatible local relay cell now carries hosted workspace
and session requests, an opaque native-chat transcript read, and the production
mobile package download through the real mobile Relay session, NaCl E2EE v2,
and Desktop transport. Hosted authority also crosses the production broker and
page client without exposing provider sessions or transcript paths. Package
delivery crosses the production asset provider and real downloader with
multi-chunk integrity, exact staging order, and atomic commit assertions. The
production cloud service, realistic Relay latency/reconnect, actual
Relay-backed WebView, Android, and physical devices remain open. Exact-source
package `31e01f57…` verifies at 49 assets, 7,819,381 bytes raw / 1,680,417 bytes
gzip after these authority call-site changes.

## Notification and Deep-Link Routing

| Intake or destination                                 | Native-shell rule                                                                                   | Hosted handoff                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `orca://pair` cold or warm link                       | Parse and replace with the native pairing-confirm route; credentials never enter the hosted page    | None                                                                                                    |
| Legacy notification opt-in and route redirects        | Keep their current native Expo Router behavior during rollout                                       | None                                                                                                    |
| Notification for a removed or unknown paired host     | Reject after a fresh native paired-host read                                                        | None                                                                                                    |
| Paired-host storage read fails                        | Reject; failure cannot prove that the payload still names a paired host                             | None                                                                                                    |
| Notification with a paired host and no workspace      | Outside Hybrid, keep the current native host route                                                  | In Hybrid, select the host and restore its hosted workspace list                                        |
| Notification with a paired host and Desktop workspace | Outside Hybrid, keep the current encoded native session route                                       | Wait for the intended authenticated host/package/page/broker session and freshly resolve the target     |
| Missing Desktop workspace after fresh resolution      | Native routing retains its existing behavior outside Hybrid                                         | Fall back to the selected host's workspace list rather than reuse a stale opaque handle                 |
| New intent while an earlier resolution is pending     | Retain only the newest monotonic intent                                                             | Reject delayed results and stale sequence, shell-session, or build contexts                             |
| Host switch, disconnect, or page/process replacement  | Keep the intent bounded in native memory; never expose the raw Desktop workspace ID in a hosted URL | Resume only after all matching readiness gates pass; ordinary page-owned route changes are not replayed |

The native resolver requests at most 10,001 `worktree.ps` entries, rejects
truncated, oversized, malformed, or ambiguous responses, registers only the
exact current workspace, and returns a shell-session-scoped opaque handle. The
page channel accepts only newer navigation sequences for the active
shell-session/build context, and the route restorer applies each accepted
revision once, including an explicit return to the workspace list. Notification
enrollment, APNs/Expo tokens, pairing credentials, raw Desktop workspace IDs,
and host connection details never enter the hosted URL or page message.

## Native Capability Inventory

| Native/platform boundary                                 | Target ownership and page exposure                                                             | Permission, gesture, and lifecycle rule                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| SecureStore credentials and Expo Crypto/E2EE keys        | Native-owned; never page-exposed                                                               | Created, rotated, repaired, and deleted with pairing identity                                                                   |
| Camera and QR pairing                                    | Native-owned pairing flow                                                                      | Camera permission and visible native scanner; pairing material never enters a web URL                                           |
| Notification enrollment, tokens, and preference plumbing | Native-owned                                                                                   | System permission and native settings UI; page receives only a typed post-selection route event                                 |
| Deep-link intake and host selection                      | Native-owned intake; typed shell-to-page navigation after a compatible host/build is active    | Buffer while disconnected or on another host; discard on host removal/session replacement                                       |
| Clipboard read                                           | User-mediated native capability                                                                | Recent explicit gesture, foreground page, platform privacy behavior, bounded result                                             |
| Clipboard write                                          | User-mediated native capability                                                                | Explicit page action, foreground page, bounded input                                                                            |
| Image, photo, camera, and document pickers               | User-mediated native capability; filesystem paths stay native                                  | Visible platform UI, permission where required, cancellation, bounded copied asset                                              |
| FileSystem and image manipulation                        | Native implementation detail behind picker/upload results                                      | Page receives bounded content/metadata, never cache or credential paths                                                         |
| Haptics                                                  | Harmless bounded native capability                                                             | Active origin/session plus rate limit                                                                                           |
| Microphone, dictation, two-way audio, and keep-awake     | User-mediated native capability using `@orca/expo-two-way-audio` and current dictation modules | Recent gesture, microphone permission, visible native state, foreground/audio-session ownership, deterministic stop/cancel      |
| Network state and endpoint lifecycle                     | Native-owned connectivity boundary                                                             | Drives typed connection state; never grants page direct network access                                                          |
| Router, safe areas, theme, app lifecycle, and rotation   | Native shell state exposed only as bounded values/events                                       | Revalidate session on foreground; pause high-volume streams in background                                                       |
| External links                                           | User-mediated native capability                                                                | Parse natively, show/confirm where appropriate, require explicit gesture, open through platform; never navigate privileged view |
| WebView origin, process, and navigation controls         | Native-owned security/recovery boundary                                                        | Restrict bridge to paired private origin, block navigation/popups/downloads, cancel resources on process loss                   |

## Terminal Protocol Mapping

The production terminal bridge adapts the existing host-owned protocol in
`src/shared/terminal-stream-protocol.ts` and Desktop terminal runtime. It does
not create a second PTY authority.

| Existing opcode/behavior               | Production WebView contract                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Output` and `OutputSpan`              | Bounded `output` batches with exclusive contiguous byte ranges; the adapter normalizes host span metadata before crossing the bridge     |
| `SnapshotStart`, `Chunk`, and `End`    | Hashed, offset-checked start/chunk/end events; 48 KiB chunks and 2 MiB total snapshot limit                                              |
| `Resized` and `Metadata`               | Typed viewport, display mode, cwd, input-floor, and query-authority events                                                               |
| `Error`                                | Stable bridge error code only; raw PTY, host, or filesystem errors do not cross                                                          |
| `Input`                                | Separate 16 KiB `input` and `queryReply` operations with monotonic input sequence                                                        |
| Clipboard/picker terminal input        | Recent-gesture-gated shell operation serialized in the same monotonic input queue; page receives status only, never content or paths     |
| `Resize` and `ClaimViewport`           | Typed resize/visibility operations; broker claims only the active view and preserves Desktop/mobile ownership arbitration                |
| `Subscribe` and `Unsubscribe`          | Typed subscribe/cancel with opaque stream ID and immediate lifecycle cleanup                                                             |
| `SnapshotRequest`                      | Explicit resync after gap, overflow, foreground, reconnect, or WebView restoration                                                       |
| `Ack`                                  | ACK through a byte sequence with a hard 256 KiB outstanding window                                                                       |
| Input floor and query-reply authority  | Reported in subscribed/metadata state; Desktop remains authoritative and validates elected query replies                                 |
| Buffer overflow and reconnect recovery | Never skip missing output; request a bounded snapshot from the existing host model, then resume at its through-sequence                  |
| Delayed input and topology routing     | Preserve current ordering and route through the existing Direct, Relay, SSH, WSL-relevant, and runtime-owner paths rather than local PTY |

## Persisted State and Migration Inventory

The inventory gate
`mobile/src/storage/mobile-persisted-state-inventory.test.ts` fails when a new
JavaScript `AsyncStorage` or `SecureStore` owner appears without updating this
table. Native package generations are included separately because they live in
the Expo module rather than JavaScript storage.

| State                            | Durable owner and scope                                                                                                                                                           | Bounds and migration/removal rule                                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paired-host metadata             | AsyncStorage `orca:hosts`; native host ID, display name, endpoint, public key, and last-connected time                                                                            | Maximum 256 hosts / 8 MiB. Pre-v0.0.3 records containing a bearer `deviceToken` are discarded; tokens never migrate through metadata.                                                                                                          |
| Pairing and Relay secrets        | Per-host `SecureStore` device token, Relay credential bundle, and Direct-upgrade journal; pairing-journal secrets use a separate device-only key                                  | `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, strict schemas, bounded serialized size. Missing/invalid secrets fail closed; host removal records durable cleanup before asynchronous key deletion.                                                         |
| Relay recovery metadata          | AsyncStorage pairing journal v1, host overlays v2, and pending credential-cleanup IDs                                                                                             | Secrets remain in `SecureStore`; entry/count/size bounds apply before parse/write. Completed pairing, orphan recovery, or host removal clears the corresponding metadata.                                                                      |
| Verified hosted packages         | iOS Application Support excluded from backup; Android `noBackupFilesDir`; host directory keyed by SHA-256 of paired public identity                                               | Staging and generation records are manifest-verified. Activation retains active/previous healthy builds, orphaned staging is cleaned at startup, quotas evict only unprotected generations, and unpair deletes the host cache before metadata. |
| Hosted cold-resume route         | AsyncStorage v1; paired-host identity plus host-workspace identity only                                                                                                           | 2 KiB record with 512-character identity bounds. Startup requires the host still be paired and freshly resolves workspace authority; missing workspace, explicit host-list navigation, or unpair clears it.                                    |
| Native-chat drafts               | AsyncStorage v1 keyed by SHA-256(host, exact build, workspace, tab)                                                                                                               | 4,096 characters; empty values delete. Exact build scoping prevents one desktop UI version from consuming another version's draft.                                                                                                             |
| Pending native-chat delivery     | AsyncStorage v1 keyed by SHA-256(host, build, workspace, tab, provider session)                                                                                                   | Shared bounded delivery count/text schema; reconciliation removes delivered or stale entries and never converts `unknown` delivery into an automatic resend.                                                                                   |
| Markdown drafts                  | AsyncStorage v1 keyed by SHA-256(host, build, workspace, tab, relative path)                                                                                                      | Content uses the shared edit byte limit and a bounded base version. Invalid/conflicting data fails closed and explicit discard/save clears it.                                                                                                 |
| Session and terminal preferences | AsyncStorage global or host/worktree/tab scoped: default/override view, text scale, autocomplete, live-input opt-out, link mode, sidebar/dock widths, pins, accessory keys/layout | Every collection and serialized record has an explicit count/character bound. Invalid entries fall back to current defaults; UI code remains the owner for both native and hosted rendering.                                                   |
| Workspace/home resume cache      | AsyncStorage home snapshot v1 and last-visited host/worktree/repository record                                                                                                    | Home snapshot is capped at 2 MiB and treated as retained presentation only; a fresh authenticated host response replaces it. Last-visited IDs are hints and must resolve against current paired-host/worktree data.                            |
| Notification catch-up            | AsyncStorage per-host last-sequence watermark                                                                                                                                     | Monotonic bounded sequence only; reconnect requests missed notifications from Desktop and advances after accepted events. Enrollment credentials do not enter this store.                                                                      |
| Legacy prototype cache           | Removed with the retired prototype route                                                                                                                                          | No production reader, writer, persisted-state inventory entry, or migration source remains.                                                                                                                                                    |
| In-memory RPC caches             | Repo, worktree, directory, browser-frame, and request single-flight caches                                                                                                        | Non-durable and process-scoped. They may improve retained presentation but cannot authorize mutations or substitute for a fresh host identity/version check.                                                                                   |

## UX-State Inventory

The native shell owns states that must remain actionable without loading a
desktop package. Once a healthy hosted interface is active, the unchanged
React Native presentation owns feature-level loading, empty, partial,
permission, and operation-error states through its native/web operation
adapters. A cached interface is retained presentation, not proof that
repository data is current.

| State                                     | Required presentation and behavior                                                                                                                                                  | Current evidence and remaining validation                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Paired-host list loading                  | Keep the existing shell mounted, show the current loading indicator and copy, and announce the status politely                                                                      | Explicit `loading` presentation state and live-region source contract; live VoiceOver/TalkBack remains open                               |
| Paired-host list failed                   | Show the existing failure copy with an announced alert and a named Retry action; Back remains available                                                                             | Explicit `failed` state plus accessibility source contract                                                                                |
| Paired-host list empty                    | Show the current empty state without implying a transport failure; pairing remains a separate native route                                                                          | Explicit `empty` state; route-level interaction fixture remains open                                                                      |
| Paired-host list ready                    | Render every paired host as a named button and keep host identity native-owned                                                                                                      | Explicit `ready` state and source contract                                                                                                |
| First verified package loading            | Keep Back and Hosts available, show “Preparing verified interface…” with a polite live-region announcement, and never render partial/unverified bytes                               | Explicit `package-loading` shell state; native stager/commit tests prove activation is all-or-nothing                                     |
| No verified package available             | Keep recovery navigation available and announce the package/cache warning as an alert; automatic refresh may continue when connectivity returns                                     | Explicit `package-unavailable` state and warning source contract; live offline recovery interaction remains open                          |
| Incompatible package with healthy cache   | Keep the last healthy interface mounted and announce that the refreshed interface requires another Orca Mobile version                                                              | Package-session tests cover deterministic compatibility copy and retained session                                                         |
| Incompatible package without cache        | Do not mount the package; show the dedicated incompatibility warning rather than a generic cache hint                                                                               | Package-session tests cover both promise completion orders through fallback-only cache copy                                               |
| Healthy hosted interface                  | Mount only the active verified session and initialize the exact build/session-scoped bridge grants                                                                                  | Production shell/broker contracts plus Direct and SSH iOS Simulator evidence                                                              |
| Cached host while offline or reconnecting | Keep the healthy hosted interface mounted, send native connection state to the existing screen, retain bounded view state, and reject operations that require a connected authority | Package-session retention test, bridge connection contracts, and real SSH reconnect evidence; broader offline surface parity remains open |
| Refresh failure with healthy cache        | Keep the last healthy interface mounted and announce a stable generic refresh warning without exposing raw host/native errors                                                       | Package-session tests cover retained and uncached generic failures                                                                        |
| Navigation outside Orca blocked           | Cancel the navigation in the native view and announce the blocked action without replacing the hosted page                                                                          | iOS/Android exact-root navigation source contracts, encoded/query rejection, and shell alert source contract                              |
| Isolated WebView process loss             | Remount the active verified generation, cancel old page resources, and announce the restart                                                                                         | Process tracker/session tests and one injected iOS WebContent-loss run                                                                    |
| Repeated process loss                     | Reject the failing build and recover the previous healthy generation; if none exists, remount with an explicit unavailable-recovery warning instead of a blank screen               | Recovery unit contracts exist; repeated-loss live validation remains open                                                                 |
| Host switch, unpair, or stale route       | Revoke the prior session and streams before switching; resolve persisted workspace identity freshly; fall back to a safe host/workspace route when stale                            | Cold-resume, host-removal, broker-lifecycle, and opaque-navigation tests                                                                  |
| Feature loading, empty, and partial data  | Preserve the existing route/component state and copy. Web adapters return bounded typed projections and must not reinterpret partial data as complete                               | Exact-source RNW route imports and focused adapter tests; deterministic native-versus-hosted fixtures remain open                         |
| Permission denied, cancelled, or revoked  | Preserve current inline/native permission flows, return stable capability outcomes, and never expose platform permission objects or raw errors to the page                          | Real iOS Photos denial/revocation and Android microphone denial/revocation pass; broader capability matrix remains open                   |
| Operation-specific failure                | Preserve the existing surface’s inline/toast/retry behavior while mapping raw Desktop/native errors to stable bridge errors                                                         | Stable error schemas and multiple route adapter tests; full per-surface interaction matrix remains open                                   |

## Accessibility and Input Inventory

Sharing presentation source preserves the current semantic intent, but it does
not by itself prove that React Native Web, WKWebView, Android WebView, and native
controls expose identical platform behavior. The required ownership and
validation boundary is:

| Area                              | Required migration behavior                                                                                                                                                                        | Current evidence and remaining validation                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VoiceOver and TalkBack            | Preserve existing labels, roles, states, reading order, headings, and actionable names; shell-owned loading uses polite live regions and failures/warnings use alerts                              | Shell/host-picker source contracts exist; live VoiceOver and TalkBack traversals remain open                                                                                                   |
| Focus and route transitions       | Preserve current initial focus, modal focus containment, Back behavior, keyboard dismissal, and focus after route/session/process restoration                                                      | Shared route/component source and the hosted Rename viewport recovery pass; deterministic focus fixtures remain open                                                                           |
| Software keyboard                 | Preserve existing input modes, accessory controls, submit/dismiss behavior, safe-area avoidance, and viewport restoration without WebView auto-zoom                                                | iOS document disables input auto-zoom and hosted Rename passed on Simulator; full route matrix remains open                                                                                    |
| Hardware keyboard                 | Preserve platform modifier handling, Tab/Shift-Tab order, Enter/Escape behavior, and terminal/browser key routing without taking the wrong input floor                                             | Browser Tab-key behavior passed on Simulator; hardware-keyboard validation on iOS/Android remains open                                                                                         |
| IME composition                   | Keep composition events intact until commit, serialize committed terminal input once, and never split or duplicate composed text across bridge requests                                            | Existing input controller and bounded ordering adapter are reused; emulator/physical IME composition evidence remains open                                                                     |
| Dictation and audio               | Keep permission, recording, interruption, cancellation, and audio-session ownership native; insert only the final bounded transcript through typed operations                                      | iOS Simulator dictation setup/download/record/process/insertion passes; interruption, device, and Android evidence remains open                                                                |
| Gesture-gated capabilities        | Observe the gesture natively, issue no reusable token to the page, consume the lease once, and bind the action to the active host/build/session                                                    | Broker/native-authority tests cover capability leases; live denial/expiry and assistive-touch paths remain open                                                                                |
| Selection, copy, paste, and links | Preserve current selection handles/actions and route clipboard/picker/external-link work through gesture-gated shell operations                                                                    | Terminal selection/copy, text and image paste with the real iOS privacy prompt, selected-document upload, and internal/external links pass on Simulator; physical-device evidence remains open |
| Rotation and responsive layout    | Reuse current phone/tablet responsive component source, preserve route/view state, and recompute safe areas and terminal/browser geometry                                                          | Portrait/landscape and background/foreground pass on iPhone Simulator; tablet, foldable, and physical-device evidence remains open                                                             |
| Reduced motion                    | Preserve the current reduced-motion response and avoid shell-only decorative animation; recovery state changes must remain understandable without animation                                        | No new shell animation was introduced; live reduced-motion audit remains open                                                                                                                  |
| Text zoom and Dynamic Type        | Preserve existing mobile text-scale preferences and readable control/layout behavior; hosted document zoom policy must prevent accidental form auto-zoom without blocking intentional user scaling | Terminal text-scale contracts and iOS input auto-zoom prevention exist; Dynamic Type and accessibility-zoom matrix remains open                                                                |

## Cross-Cutting Inventory Status

| Area                           | Status                       | Completion requirement                                                                                                             |
| ------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Expo Router routes             | Complete                     | Every current route has a target owner and migration decision above                                                                |
| RPC requests and subscriptions | Complete                     | Callers, allowlist, operation registry, grants/bounds, named adapters, topology, and cleanup are frozen above                      |
| Terminal contract              | Complete                     | Existing opcodes, batching, ACKs, floor ownership, input/query ordering, snapshots, and recovery are mapped                        |
| Native capabilities            | Complete                     | Every current native/platform boundary is classified with page exposure, permission, gesture, and lifecycle rules                  |
| Persisted state                | Complete                     | Every durable JS/native store, scope, bound, cleanup path, legacy source, and migration rule is frozen above                       |
| UX states                      | Complete                     | Loading, empty, offline, reconnect, incompatible, partial, permission, retained, recovery, and error behavior mapped               |
| Notifications and deep links   | Complete                     | Native fallback, host selection, readiness, fresh resolution, opaque handoff, stale suppression, and redirects mapped              |
| Accessibility and input        | Complete                     | Screen reader, focus, keyboard, IME, dictation, gesture, selection, layout, motion, and text-scale behavior mapped                 |
| UI source and visual behavior  | Implemented; validation open | Existing screen/component/style source is reused; complete the remaining screenshot, interaction, accessibility, and device matrix |

Clipboard availability, clipboard text/image paste, and photo/document
attachment now have strict shell-owned contracts. The iOS Simulator passes the
native photo permission, picker-cancel path, and selected-photo upload from the
unchanged Attach control. The shell created a 2,808,983-byte host temp PNG;
focused tests cover accepted/cancelled/permission/size feedback plus local and
SSH upload authority. The exact cached iPhone app now accepts the real iOS paste
privacy prompt and delivers an exact text marker through the unchanged hosted
Paste control to the temporary Desktop terminal. The same gate denies the real
first-use Photos prompt from unchanged Attach, shows the existing denial toast,
retains the exact Session, leaves Desktop terminal output unchanged, and
shows no image data or `orca-paste-` marker in hosted page text. Focused
contracts separately require a status-only result. A focused exact-app run now
copies the 48×48 fixture through Photos, accepts the real iOS paste prompt,
injects only the shell-owned host path into the terminal, and independently
matches the 411-byte result's decoded RGBA SHA-256
`a2773eaed936229595e49669b8705cb179a6a004a48a4d8304d6ee2710ab26b9`.
No filename, path, pixel digest, encoded prefix, or `data:image/` marker reaches
hosted page text. A focused exact-app gate now grants and revokes Photos across
the two iOS process terminations, restores the same semantic Session/workspace
through the native Settings handoff, rotates private origin and opaque authority
after each restart, and preserves denial, terminal/page isolation, and both
network/navigation probes. The real picker also resumes after Home/foreground;
explicit Cancel returns to the same Session with private origin and opaque
authority retained. Physical-device evidence remains open.
Camera is native QR pairing only; the existing attachment UI has no camera
action. The live run did not observe terminal Enter execution after the photo
upload. Long-pressing the same unchanged control opens the native iOS document
picker. A deterministic Files selection now uploads a 123-byte PNG through
shell-owned host authority, injects only the host temp path into the terminal,
and matches the source SHA-256
`dec4a91731905b9e8ed450a6c46931258528fc034fcfc64d95b0b23264f8e9d4`.
The filename, bytes, digest, and temp path remain absent from hosted page state.

Native-chat composer drafts now cross a named persistence operations seam
without changing composer JSX or behavior. Hosted code sends only opaque
workspace/tab IDs. The broker resolves current host authority, and the native
store hashes paired-host, exact-build, host-workspace, and tab identity before
reading or coalescing bounded writes. Native mode uses the same 4,096-character
store through its default adapter. On iPhone 17 Pro Simulator, the exact unsent
draft survived forced termination of every simulator WebContent child with the
same hosted route and chat tab restored. It also rehydrated after a full app
terminate/launch and manual Host 37/session re-entry.

Cold route restoration now persists only bounded native paired-host and
host-workspace identity. It never stores an opaque page handle. Pairing deep
links retain startup priority. Otherwise the shell verifies that the paired
host still exists, selects it, resolves the workspace from a fresh current
`worktree.ps` response, and issues a new shell-session-scoped opaque handle to
the hosted page. A missing workspace clears the stale route and falls back to
the workspace list. Explicit host-list navigation and paired-host removal also
clear the route. A live full app terminate/launch bypassed the host picker and
returned to Host 37 plus the unchanged `mobile-rearch` session; the exact chat
draft remained in its hashed host/build/workspace/tab store. Markdown drafts
and pending-delivery persistence now use the exact hashed scopes recorded
above. The remaining work is runtime/device lifecycle evidence, not discovery
of an unowned durable store.

The gated production entry seam now covers Home host selection, workspace-list
entry, exact-session resume, Tasks, Accounts, New Workspace, pairing and
onboarding completion, notification navigation, and cold resume. Transient
Tasks, Accounts, and New Workspace destinations are not written into persisted
resume state. Without `EXPO_PUBLIC_ORCA_MOBILE_WEB_DEFAULT=1`, the unchanged
native routes remain the default and fallback.

Dictation now has strict hosted contracts for setup reads/mutations, model
download/delete, start/stop/cancel, and lifecycle subscription. The native
shell owns microphone permission, `@orca/expo-two-way-audio`, keep-awake,
PCM buffering, backpressure, and the Desktop speech session; the page receives
no PCM, permission object, model path, or Desktop error. The paired iOS
Simulator passes setup-required routing, model metadata, configuration,
download, recording, processing, and transcript insertion through the existing
mobile controls and drawer. Two-way playback, background/interruption,
denial/revocation, Android, physical devices, and accessibility review remain
open.

Accounts now use strict hosted snapshot, selection, and subscription contracts
behind the existing screen. The page receives bounded IDs, emails, optional
labels, and rate-limit state only. Selection consumes a recent native-observed
gesture, while route exit, cancellation, client replacement, and broker
disposal retire the Desktop subscription. Credentials, auth paths, provider
IDs, and unrelated provider state never enter the page result.

## Production Contract Status

| Contract                         | Status                                          | Source                                                                                                                                       |
| -------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-asset manifest v1          | Implemented and focused-test passing            | Exact path and extension/MIME/role maps with mirrored TypeScript/Swift/Kotlin corpora; exact scalar types before staging                     |
| Manifest resource bounds         | Implemented, measured, and focused-test passing | 256 KiB/raw manifest before native parse; 48 KiB chunks / 65,536 base64 chars before native decode; 10 MiB/asset, 32 MiB/package, 256 assets |
| Document CSP                     | Implemented and focused-test passing            | One shared directive contract drives packaging/verification and exact-sequence checks for both native response policies                      |
| Bridge envelope and capabilities | Implemented and focused-test passing            | `src/shared/mobile-web/bridge-contract.ts`; bounded native-chat schemas and remaining operation payload schemas                              |
| Terminal stream                  | Implemented and focused-test passing            | `src/shared/mobile-web/terminal-stream-contract.ts`; broker adapter and real-stream validation remain                                        |
| Shell navigation events          | Implemented and focused-test passing            | Strict opaque routes with monotonic sequence, shell-session/build context, and one-shot restore                                              |
| Stable bridge errors             | Implemented and focused-test passing            | Strict stable enum; response/error schemas reject raw Desktop/native messages                                                                |
| Shell compatibility range        | Implemented and policy frozen                   | Exact v2 package/shell contract; capability-based additive changes; two-stable-release floor retention before supported-minimum advancement  |
| Bridge request/subscription caps | Implemented and focused-test passing            | 640 KiB envelope, 64 pending requests, 32 subscriptions, per-operation byte/concurrency/rate grants                                          |
| Package read concurrency         | Implemented and focused-test passing            | Four concurrent 48 KiB reads / 192 KiB in flight per connection                                                                              |
| Terminal stream memory           | Implemented and focused-test passing            | 16 KiB input, 64 KiB output batch, 256 KiB outstanding, 2 MiB snapshot                                                                       |
| Native verified cache            | Implemented and native-policy-test passing      | 128 MiB per host, 512 MiB global, 16 MiB minimum free; protected generations; bounded persisted manifests, activation metadata, and assets   |

Manifest and package-RPC validation now consume the same exact asset-path
predicate. Swift additionally requires its regular-expression match range to
cover the full string rather than ending before a trailing newline. The
mirrored native/shared corpus rejects empty, absolute, traversal,
repeated-separator, percent-encoded, query, fragment, backslash, non-ASCII,
overlong, and trailing-newline paths.
The shared protocol-token contract likewise requires exact SHA-256, Git object
ID, fixed/ranged base64url, canonical base64, and domain-token matches. The
directly loaded manifest contract applies the same exact hash rule locally.
Bridge envelopes, terminal streams, package delivery, file content,
source-control revisions, and provider-review contracts consume full-string
predicates rather than newline-permissive end-anchored Zod regexes.
The manifest's extension/MIME/role table is now authoritative for source-parity
tests over both native maps. Each runtime also passes the same eight valid and
eight mismatched metadata cases, including case, charset, role, extension, and
hash mutations.
Persisted primary and canonical manifests now use 256 KiB bounded readers,
activation records use a 1 KiB bounded reader, and assets use their declared
length on both native platforms. Each path reads only one overflow byte before
failing with its stable error, and mirrored Swift/Kotlin oversized-file faults
pass. Activation parsing is also exact on both platforms: only `active` and an
optional distinct `previous` string hash are accepted, while the mirrored
shape/type/trailing-token corpus fails with
`mobile_web_activation_invalid`. Persisted cache reads additionally require a
regular descendant of the native cache root. The mirrored boundary corpus
rejects outside-root, symlinked, non-regular, and missing inputs before any
manifest, activation, or executable asset bytes are consumed. Primary and
canonical manifests plus activation metadata also pass a bounded exact JSON
grammar before native parsing. Duplicate decoded keys, trailing tokens,
malformed scalars, and nesting beyond 32 levels fail consistently on both
platforms. Escaped Unicode surrogate pairs and raw supplementary characters
pass, while unpaired surrogate escapes in keys or values fail before platform
JSON parsing. Cache mutation faults additionally require every destructive
Android store path to delete only lexical descendants without following
symlinks; quota traversal ignores linked trees. Direct, nested, and
live-stage-replacement links plus host-subtree and dangling host links preserve
external sentinels on both native stores. Staged-asset and activation-host
writes reject linked paths before opening them. Atomic activation replacement
replaces an in-cache file link without changing its external target.
The mirrored native generated corpus rejects 1,152 malformed manifest, chunk,
offset, path, and SHA-256 cases per platform. Both stores also pass 72
concurrent cache flows spanning distinct hosts, duplicate generation
commits, and same-host open/read/activation. Android uses the API-8 platform
base64 codec at the minSdk 24 boundary and guards optional WebView features
before registration or removal; its module lint reports zero errors.
The standalone renderer-based workspace, session, files, terminal,
source-control, and review presentation is also removed with its Vite-only
package path. A production-source boundary requires `src/mobile-web/` to remain
renderer-independent, while the authoritative RNW package still verifies as
build `f293890e…`.
Raw bridge envelopes, including initial shell setup, now pass an exact
unique-key, paired-surrogate, bounded JSON grammar before schema parsing. The
generated broker corpus rejects 2,025 malformed or oversized requests across
all 225 production grants before host or native access. Valid response
envelopes also cross 157 exported result schemas and all eight subscription
event schemas with invalid payloads; requests fail closed and invalid events
cancel their subscriptions. Pending terminal/native-chat setup cannot register
after early cancellation, client replacement, or broker disposal.
The first production shell and package use exact bridge v2. Additive operations
remain compatible through negotiated capabilities. Any incompatible successor
must ship natively first, retain v2 for at least two stable mobile releases, and
wait for the supported store-shell minimum to advance before Desktop raises
the package floor.

The
[production rollback runbook](../mobile-hybrid-webview-rollback.md)
now freezes the operator boundary as well: Desktop incidents require a verified
corrected Desktop artifact that stops serving the rejected package, native
incidents require store containment and a corrected native release, and
host-scoped recovery never relies on manual activation or cache-file mutation.
The final physical-device and store-signed rollback drills remain release
evidence rather than inventory completion.

## Next Inventory Action

The dedicated hosted Files, Preview, Source Control, Review, and Agent History
routes mount the unchanged presentations through native/web adapters. The
iPhone 17 Pro Simulator verifies Session-origin changed-file handoff,
standalone Review, and the isolation probes. The Pixel 9 Pro API 36 emulator
now verifies those paths in the same fresh app session as Agent History scopes,
preview, filtering, synthetic-resume rejection, and native-touch resume.
The iPhone fixture also captures native and hosted Tasks and Session from the
same disposable runtime: Tasks passes at 0.022% changed pixels / 0.084 mean
channel difference / 0.000016 vertical-title delta, and Session passes at
0.800% / 1.693 / 0.000366 within the 3% / 4 / 0.005 budgets. Provider-neutral
History and PR compatibility redirects are present. The non-embedded Tasks
toolbar icon's missing native accessibility label remains open. Close the
remaining native-versus-hosted interaction matrix.

Fresh exact-app iOS and Android emulator runs now prove executable isolation at
the native asset origin. Each hosted document loaded its active
manifest-declared content-addressed script, failed to load a mutated undeclared
same-origin script, and remained intact. The same runs passed network and
navigation isolation; Android recorded no sentinel traffic or native bridge
error. Physical-device, store-signed release, fuzz, and independent-review
evidence remains open.

The iOS fixture now also navigates the unchanged Files tree into the real
`Casks/orca.rb` Preview in native and hosted modes. Files measures 0.030%
changed pixels / 0.128 mean channel difference and Preview measures 0.061% /
0.274, within the 3% / 4 budgets. Both the cached-app and fresh Xcode
build/install complete journeys pass. Hosted Preview source identity is stable
across equivalent route rerenders, while web typography follows the existing
native iOS fallback rather than introducing a replacement presentation.

The same deterministic fixture now captures the unchanged Accounts screen
before continuing through the rest of the route matrix. Accounts measures
0.050% changed pixels / 0.099 mean channel difference / 0.000544
vertical-title delta, within the 3% / 4 / 0.005 budgets. The driver uses the
existing unlabeled non-embedded toolbar icon position; its missing
accessibility label remains part of the open VoiceOver review rather than a
presentation change in this migration.

The fixture now starts by capturing the unchanged base workspace screen in
native and hosted modes. Workspace measures 0.879% changed pixels / 1.876 mean
channel difference / 0.000395 vertical landmark delta, within the 3% / 4 /
0.005 budgets. This proves the shared `HostScreen` itself before the same
fixture navigates into Accounts and the downstream route matrix.

The Source Control/Review fixture now runs against the full 1,294-file branch
comparison rather than a byte-truncated prefix. Desktop responses are bounded
to 128 revision-consistent entries per page and 4,000 entries in aggregate;
the hosted adapter assembles the pages and rejects a revision change. Native
and hosted show the same `0/1294 reviewed` state, first file, and diff without
forking the shared presentation. Source Control measures 0.736% changed pixels
/ 0.910 mean channel difference and Review measures 2.134% / 1.947, within the
3% / 4 budgets. `viewport-fit=cover` supplies native safe-area insets, and RNW
nested syntax text follows the native effective font.

The interrupted-transcript versus hook-status mismatch and a real structured
prompt response pass Host 37 Simulator replay. Current package `f293890e…`
also carries the network-denied local Mermaid engine and its WebKit-compatible
token-bound parent/frame handoff. Classic SSH
transcript authority and reconnect now pass a real Docker provider journey
without local fallback, and the same topology has a durable actual-WKWebView
terminal mutation and native-chat reconnect path. The real mobile
Relay/hosted-bridge and production package-download composition passes through
a protocol-compatible local cell. The UX-state and accessibility/input
ownership inventories are now frozen, including accurate incompatible-build
fallback copy and shell alert/live-region semantics. Complete live
waiting/loading/error, ambiguous-delivery, file-opening, production cloud Relay
with realistic latency/reconnect. Complete physical-device attachment evidence
after the selected-photo, selected-document, first-use denial, post-grant
revocation, and picker-interruption paths proven on iOS Simulator.
Keep camera validation scoped to the existing native QR-pairing route rather
than inventing an attachment action. Add
deterministic native-versus-hosted Tasks and session fixtures beyond the
completed manual iOS Simulator passes. Finish the notification/deep-link
live matrix with connected Host 37: exact session, missing target, consecutive
taps, background/foreground, and cold start. The exact-session fixture reaches
iOS Notification Center, while the current serve-sim and Simulator
accessibility controls do not deliver its default action; use a reliable manual
tap path, physical device, or repaired emulator control before closing the gate.
Collect the remaining live VoiceOver/TalkBack, keyboard/IME, reduced-motion,
text-scaling, production-cloud Relay, Android, physical-device, and
runtime-owner evidence without treating the completed contract inventories as
live-device proof.
