# iOS agent overview Live Activity

Issue: [#8127](https://github.com/stablyai/orca/issues/8127).
The macOS notch in [#47748](https://github.com/stablyai/orca/pull/47748) is context;
this feature does not depend on or modify that branch.

## Behavior

Enable **Settings → Notifications → Live Activities** in a rebuilt native iOS app.
Opening a working session starts one global overview of the phone's paired
computers and known relayed servers. The compact Dynamic Island shows working
and attention counts. Failures contribute to the attention count. Expanded and
Lock Screen presentations show prioritized sessions, their state and elapsed
state time, with a remainder count for sessions that do not fit. The expanded
Island shows up to two rows; the Lock Screen shows up to three.
The Lock Screen uses the available height for each session's title and an explicit
state label. Large text reduces the visible rows while preserving totals.
Session rows show their agent's existing bundled icon (Claude, Codex and the other
supported agents), independently of the status indicator. Unknown agents use a
terminal symbol. Aggregate working/attention counters retain neutral state icons.

The source set includes the saved phone host catalog and servers discovered through
each connected desktop's existing relay catalog. It is bounded to 32 source grants,
including aliases; exceeding this bound refuses enrollment instead of silently
truncating the total. New pairings or discovered servers rotate the overview on
foreground reconciliation. An offline host or an unreadable catalog does not mean
zero agents: counts become lower bounds, marked **≥**, with **Partial coverage**.
A fully stale card shows unavailable data.

Each executor contributes its own terminal and structured-chat sessions across
worktrees and folder workspaces, including sessions never opened on the phone.
PTY and saved-tab ownership exclude remote mirrors. Conversation identity
deduplicates alternate views on one host; the gateway deduplicates direct/relayed
aliases of the same authenticated host. Subagents are not separately invented
from prompts or tool output. Recent completed/failed outcomes remain visible for
about five minutes, refreshed by host updates and heartbeats; intentional stops
are excluded.

The overview remains active when all tasks finish so a new task can update it
while the app is suspended. Activity creation still requires the foreground app;
push-to-start is not implemented. iOS limits an activity to eight hours. After
expiry or user dismissal, a later working turn opened in the app can create a
new overview. No foreground JavaScript socket is assumed to run while suspended.

Names are hidden by default; the agent type/icon and state remain visible. **Show session names** separately consents to sending
bounded session titles through Orca's push service and APNs. The gateway masks
titles unless the overview's control registration allows them. Native titles are
also marked privacy-sensitive. Prompts, commands, terminal output, provider error
details, host addresses and workspace paths are not added as metadata. Changing
privacy or disabling the feature ends the current card and its enrollments.

Each session row has its own link; tapping the compact overview opens Orca.
Links contain only opaque overview/scope/session identifiers. The phone resolves
the source using its local route map, reconnects with saved credentials, and asks
the authenticated executing host to resolve the session identifier. The host
revalidates current ownership before returning a workspace/pane. Existing
notification navigation handles local, folder and remote destinations. Closed,
revoked or unavailable destinations fall back to the host screen, not another
session.

## Architecture and suspended updates

- The local Expo module and generated WidgetKit extension use versioned
  OrcaAgentOverviewAttributes. Old per-session activities are ended on upgrade.
  An older native module without the overview bridge is unavailable to new JS.
- Native routes retain only the trusted paired-host/execution-host destinations.
  Enrollment control and per-source secrets live in the phone's Keychain.
- The phone gives one coordinator host the ActivityKit token and control
  credential. Other hosts receive only their own contribution credential.
  Token changes and coordinator failover are fenced by a persisted control
  revision; stale bootstrap requests cannot restore an old token.
- Each host keeps a revocable device-scoped enrollment and a durable contribution
  sequence. It follows canonical session publications without a phone subscription.
  Initial/renewed inventories require the existing authoritative census; uncertain
  ownership or unreadable sessions remain partial. Tool-only updates are coalesced.
- /v1/live-activities/register bootstraps an immutable source cohort. The
  authenticated /v1/live-activities/send accepts host-scoped contributions, not
  arbitrary whole-overview APNs updates. Source secrets are hashed into public
  scope IDs and bound to the authenticated host fingerprint.
- The gateway persists the cohort, contributions and delivery leases in the
  existing SQLite/PostgreSQL database. It merges only fresh source data using
  gateway receipt clocks, applies privacy, and picks attention/failure/working rows.
  Only this gateway sends the complete APNs content state.
- A durable single-writer lease and whole-second timestamp ordering serialize
  APNs delivery across worker processes. In-flight old-token results cannot erase
  a rotated activity. Replayed source sequences cannot refresh stale coverage.
  Freshness expiry is scheduled even when no new host request arrives.
- Contributions retry after failure and send five-minute heartbeats. The gateway
  coalesces unchanged summaries and expires source freshness after 15 minutes.
  The widget itself never fetches network data; SwiftUI updates elapsed time.
  Combined content is byte-bounded, with at most three short opaque session rows.

Android and web clients use the unavailable native bridge. Ordinary push
notification preferences remain independent.

## Build and external requirements

This changes the native fingerprint. Expo Go or a JS-only update cannot install
the ActivityKit module or widget extension.

```sh
pnpm -C mobile install --frozen-lockfile
ORCA_BACKGROUND_LAUNCH=1 pnpm -C mobile native ensure ios --rebuild
ORCA_BACKGROUND_LAUNCH=1 pnpm -C mobile start --dev-client
```

The Expo plugin copies the widget/attributes Swift into the generated iOS target.
After editing those sources, refresh the generated copies before using a direct
xcodebuild command. A successful build of stale generated Swift does not qualify
the changed source. Generated iOS files are not committed.

Physical builds need the app profile and a separate
com.stably.orca.mobile.activity extension profile in the same Apple team.
Fastlane does not create a missing extension App ID. The app's actual
aps-environment selects sandbox or production; the extension needs no App Group.
All source hosts need this registration contract and the gateway needs both new
endpoints, the additive overview tables, and its overview worker running.
An older source cannot contribute and remains unknown.

Deployment is owned by the private stablyai/orca-cloud infrastructure. This
change does not deploy it or create certificates, provisioning profiles or APNs
keys. Required gateway credentials remain ORCA_PUSH_APNS_KEY,
ORCA_PUSH_APNS_KEY_ID, ORCA_PUSH_APPLE_TEAM_ID and ORCA_PUSH_APNS_TOPIC.
Durable gateway acceptance proves enrollment, not APNs delivery on a phone.
Token rotation without a usable authenticated host connection waits for
reconnection. New source enrollment also requires the foreground phone.

## Qualification

Local checks cover real device-registry persistence/revocation, overlapping host
updates, authenticated gateway merging, alias deduplication, hidden-name
serialization, replay rejection, freshness expiry, cohort ownership and
old-token in-flight fencing. Native iOS builds and simulator screenshots are
separate from physical-device APNs qualification.

Use an explicit model, OS, build, APNs environment and viewport. Keep screenshots
outside Git. The temporary simulator fixture uses the shipping widget with
synthetic multi-host counts; it qualifies presentation only.

1. Check one overview with several sessions across multiple hosts, hidden names,
   opted-in names, compact/expanded/minimal and Lock Screen presentations.
2. Check attention/failure ordering, extra-session count and large text; tap
   different rows cold/warm into exact local, folder and remote sessions.
3. Suspend/lock a physical iPhone, then start, finish and fail tasks on several
   already enrolled hosts without reopening the app. One finished host must not
   end the overview or erase another host's work.
4. Disconnect one host past freshness expiry. Healthy counts remain lower bounds;
   unavailable hosts must not be reported as zero or keep a confident old count.
5. Restart a host and gateway; exercise token rollover, coordinator failover,
   revocation, new/removal pairings, dismissal and privacy changes.
6. Recheck ordinary Android notifications and web sessions.

The global native app compiles, and the separate simulator fixture exercises
the shipping overview widget with synthetic multi-host data. These checks do not
qualify the complete global data path. Physical-iPhone suspension, production gateway deployment, signed archives and
exact session tap routing still require qualification. The machine has no valid
physical-device signing identity. The existing aiialabs-bryan server and its
notch-validation processes were inspected read-only and preserved.

Official references:
[ActivityKit lifecycle](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities),
[ActivityKit APNs updates](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications),
[Apple Live Activity design](https://developer.apple.com/design/human-interface-guidelines/live-activities),
[Expo local modules](https://docs.expo.dev/modules/overview/).
