# iOS agent Live Activities

Issue: [#8127](https://github.com/stablyai/orca/issues/8127). The macOS notch in
[#47748](https://github.com/stablyai/orca/pull/47748) is related context; this feature
does not depend on that branch.

## Behavior

Enable **Settings → Notifications → Live Activities** on an iPhone. This switch is
independent of ordinary notification permission. Opening a working agent session
starts an activity, up to four per phone. Sessions can be terminal agents or
structured chats, in worktrees or folder workspaces, on the paired computer or a
server reached through it. A session already being followed keeps its activity
when you change tabs or leave the app.

The Lock Screen and compact, minimal and expanded Dynamic Island show durable
working, attention, completed and failed states. Elapsed time uses SwiftUI's timer,
without JavaScript timers or pushes every second. A completed or failed activity
ends and remains on the Lock Screen for up to five minutes, subject to iOS policy.
Missing/stale evidence is shown as unavailable, never as successful completion.

Names are hidden by default. **Show session names** separately consents to sending
the bounded display title through Orca's push service and APNs and displaying it
on the Lock Screen. Prompts, terminal output, commands and provider error messages
are never included. The name is also marked `privacySensitive` in SwiftUI. Changing
either preference immediately dismisses existing cards. A later turn can start a
new one with the new privacy choice.

Taps contain only a random local link ID. The native app resolves its stored
host/workspace/pane/execution-host destination and reuses notification navigation,
including saved-host and credential checks. URLs contain no pairing credentials.
Destinations and dismissed-turn tombstones are bounded and retained across app
restarts so the same turn is not recreated after dismissal.

## Architecture and suspended updates

- `mobile/modules/orca-live-activities`: a local Expo module using ActivityKit.
  It requests `.token` activities, observes token and lifecycle changes, reattaches
  existing activities and reads the system authorization on start/resume.
- `mobile/plugins/ios-live-activities.js`: generates the WidgetKit extension target
  during Expo prebuild, sharing the Codable attributes source with the native
  module. `ios/` remains generated and is not committed.
- The host-served session page uses the optional, validated
  `native.liveActivity.track` bridge verb. The shell binds the paired host and owns
  native tokens/preferences. Old shells omit the grant. Android and browser clients
  use the unavailable native implementation and continue working.
- `notifications.registerLiveActivity` / `unregisterLiveActivity` run on the
  execution host. The transport, not request parameters, supplies the paired mobile
  principal. Relayed servers receive their delegated principal.
- `HostLiveActivities` follows canonical mobile session-tab publications without a
  mobile socket subscription. Status/failure/freshness are the existing agent
  contracts. Registrations live with the revocable device registry and survive host
  restart, with an eight-hour maximum lease. Sends recheck the principal and its
  ancestors. No session is started or awakened to keep the activity alive.
- Durable state changes are sent to the gateway. One deadline timer handles latest
  state retries, ordering at whole-second APNs timestamps, five-minute heartbeats
  and lease expiry. Intermediate tool events do not generate separate pushes.
- The authenticated gateway endpoint `/v1/live-activities/send` reuses APNs token
  authentication and HTTP/2 transport. It sends `apns-push-type: liveactivity`, the
  app topic suffixed with `.push-type.liveactivity`, and bounded `aps` content. The
  private APNs key stays in the service. Registration succeeds only after APNs
  accepts the initial update; that acceptance does not prove delivery on a phone.

After registration, the host and gateway send directly to APNs while the app is
suspended or the phone is locked. The widget has no network connection. An update
sets a 15-minute stale date; the widget renders an unavailable state when iOS marks
it stale. Host or gateway loss therefore does not leave an indefinitely confident
working label. Delivery remains subject to APNs connectivity and Apple's budgets.

Activity creation requires the foreground app. Tasks started while the app is
suspended do not create new activities; push-to-start is not implemented. Activity
token rotation is observed and retried through connected hosts; if iOS rotates a
token while the app has no usable authenticated host connection, registration
waits for reconnection. No background WebSocket runtime is assumed. iOS also limits
activity duration to eight hours. Devices without Dynamic Island can use the Lock
Screen; unsupported or system-disabled devices cannot enable the feature.

## Build and infrastructure requirements

This changes the native fingerprint and requires a new native client, not Expo Go
or a JavaScript-only update. From the checkout:

```sh
pnpm -C mobile install --frozen-lockfile
ORCA_BACKGROUND_LAUNCH=1 pnpm -C mobile native ensure ios --rebuild
ORCA_BACKGROUND_LAUNCH=1 pnpm -C mobile start --dev-client
```

Use Xcode to build/install on a physical iPhone with development signing. The app
and `OrcaSessionActivity` extension need separate provisioning profiles. Register
the extension App ID `com.stably.orca.mobile.activity` in the same Apple team before
using the release lane; Fastlane obtains profiles but does not create a missing
App ID. The extension needs no App Group or separate APNs entitlement. The app
already has `aps-environment`; `app.config.js` passes its actual selected environment
to the ActivityKit bridge (`development` → `sandbox`). Release uses
`ORCA_IOS_APS_ENVIRONMENT=production` as before.

The push service must deploy this endpoint using an APNs key authorized for the
app's Live Activity topic and correct environment. Its credentials are
`ORCA_PUSH_APNS_KEY`, `ORCA_PUSH_APNS_KEY_ID`, `ORCA_PUSH_APPLE_TEAM_ID` and
`ORCA_PUSH_APNS_TOPIC`. Cloud deployment is owned by the private
`stablyai/orca-cloud` repository. This change does not deploy that service or create
Apple credentials. An older gateway cannot update activities; the phone ends the
unregistered card and reports the failure in Live Activities settings.

Official references:
[Apple ActivityKit updates](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications),
[Apple Live Activity lifecycle](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities),
[Expo local modules](https://docs.expo.dev/workflow/customizing/),
[Expo module API](https://docs.expo.dev/modules/module-api/).
Expo also offers `expo-widgets`; the existing local-module architecture and a small
SwiftUI extension avoid adding a separate JavaScript widget runtime for this surface.

## Manual qualification

Use an explicit iPhone model, iOS version, build type, APNs environment and viewport.
Keep screenshots outside Git and attach before/after images to the eventual PR.

1. With the preference off, start a session; no card should appear. Enable it and
   open a new working turn. Check generic names, then separately opt in to names.
2. Check compact, minimal, expanded and Lock Screen layouts, light/dark and large
   text. Verify elapsed time changes while JavaScript is suspended.
3. Lock a physical phone and allow the agent to request attention, complete and
   fail. Verify each update without reopening the app. A simulator injection alone
   does not qualify APNs or suspension behavior.
4. Tap cold and warm cards repeatedly. Check exact terminal/chat selection, folder
   workspaces, directly paired servers and relayed remote execution hosts.
5. Dismiss an activity, respond to an attention request, reconnect and cold-launch.
   Verify no duplicate or resurrected card for the same turn. Exercise token
   rollover, host restart, host revocation, disable and privacy changes.
6. Disconnect host/gateway and check stale rendering. Restore connectivity and
   verify recovery. Check ordinary Android notifications and browser sessions.

Local validation on the implementation machine includes Expo prebuild, TypeScript,
the actual web bundle build and focused privacy/persistence/APNs wire checks.
This machine has Command Line Tools but no Xcode/simulator. Swift syntax parsing
is not a Swift/WidgetKit build. No simulator, physical-iPhone, signed archive,
Lock Screen screenshot or production APNs delivery has been verified here. The
Linux host `aiialabs-bryan` was inspected read-only over Tailscale; its existing
notch-validation server and agents were preserved. It has not run this new build.
