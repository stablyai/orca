# Apple Watch action spike: build and test runbook

Spike branch `CJNA/orca-applewatch`. **Do not merge**: the native module autolinks into every build.

## What we're proving

Watch controls would ride on iPhone notifications that mirror to the Watch: **Yes / No** buttons and a
**Reply** text action (system dictation). iOS runs a background action on the **iPhone**, even when it's
tapped on the Watch. So the phone has to wake, read pairing credentials, reach the desktop over E2EE
(LAN or relay) and get an answer, all while it's locked and within its background time.

Decisions in force:

- A locked phone may approve (pairing keychain becomes readable after first unlock).
- Double Tap may approve (Yes is the first nondestructive action).

## What the build contains

| Piece                 | Path                                                                | Role                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Native module         | `mobile/modules/orca-watch-action-spike/ios/`                       | Logs every launch and spike tap natively (works even if JS never runs), holds ~30s of background time, switches pairing keychain accessibility |
| Category, arm, result | `mobile/src/watch-action-spike/watch-action-spike-notifications.ts` | Yes/No/Reply category, local test notification, result notification                                                                            |
| Tap handler           | `mobile/src/watch-action-spike/watch-action-spike-response.ts`      | Started from `mobile/index.js`; refuses taps that reach JS more than 30s late (`stale`)                                                        |
| Round trip            | `mobile/src/watch-action-spike/watch-action-spike-round-trip.ts`    | Keychain read → `openHostLogicalClient` → `status.get`                                                                                         |
| UI                    | `mobile/src/watch-action-spike/WatchActionSpikeRow.tsx`             | "Watch test" section in Settings → Troubleshoot                                                                                                |

Everything is gated on `ORCA_WATCH_SPIKE=1` at build time (`app.config.js` → `extra.orcaWatchSpike`),
except the native module, which links unconditionally but only acts on its own notification category.

No desktop or cloud changes are needed. Any paired desktop running a normal Orca works.

## 1. Prerequisites (Mac)

- Xcode 27.1 (matches `mobile-ios-release.yml`), with your Apple ID signed in on the **Stably** team
- Node 24+, pnpm (`corepack enable` gives the pinned `pnpm@12.14.0`)
- iPhone with **Developer Mode** on (Settings → Privacy & Security → Developer Mode), connected by cable
- Apple Watch paired to that iPhone (Series 9 / Ultra 2 or later for the Double Tap test)
- Desktop Orca running and already paired with the iPhone

## 2. Build and install

```bash
git fetch origin
git checkout CJNA/orca-applewatch
git pull

cd mobile
pnpm install

# Release bundles the JS, so background launches don't depend on Metro.
ORCA_WATCH_SPIKE=1 npx expo run:ios --device --configuration Release
```

- Pick the iPhone when prompted.
- If signing fails, open `mobile/ios/Orca.xcworkspace`, choose the Stably team under Signing &
  Capabilities for the app target, then rerun the command.
- This build replaces the App Store Orca on the phone (same bundle ID). Pairing should survive. If the
  host shows as missing, re-pair from desktop.
- Not on the Stably team? Use your own bundle ID:
  `ORCA_IOS_BUNDLE_ID=com.yourname.orca ORCA_WATCH_SPIKE=1 npx expo run:ios --device --configuration Release`.
  This needs a paid account because of the push entitlement, and you must re-pair.

**If the Swift doesn't compile:** this code was written on Windows and has never been compiled. Copy the
first Xcode error back to the agent. The likely spots are the `NotificationCenterManager` /
`NotificationDelegate` import from `ExpoNotifications` and the `ExpoAppDelegateSubscriber` signature.

## 3. One-time setup

1. Open Orca on the phone. Allow notifications if asked. Check that the desktop host connects.
2. iPhone **Watch** app → Notifications → Orca → **Mirror iPhone Alerts** on.
3. Orca → Settings → **Troubleshoot** → scroll to the **Watch test** section.
   - **Watch test host** shows the host it will dial. Tap it to cycle if you have several.
   - **Pairing readable while locked** stays **Off** until test 4.

Notifications only go to the Watch while the iPhone is **locked** and the Watch is on your wrist and
unlocked.

## 4. Tests

For every test: tap **Arm**, lock the iPhone immediately with the side button, raise your wrist and wait.
Note the result notification on the Watch.

| #   | Steps                                                                         | What it answers                                 | Expected                                              |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| 1   | **Arm 15s**, stay in the app, long-press the banner, tap **Yes**              | Plumbing works                                  | `✓ Yes reached host`                                  |
| 2   | **Arm 60s**, lock, tap **Yes** on the Watch                                   | Does a locked phone with today's keychain fail? | `✗ Yes failed at keychain`                            |
| 3   | Same as 2, but **Double Tap** instead of tapping                              | Does Double Tap fire Yes?                       | Same result as 2, action `yes`                        |
| 4   | Turn **Pairing readable while locked** **On** (phone unlocked), then repeat 2 | Does decision 1 fix it, and how fast?           | `✓ Yes reached host in …ms`                           |
| 5   | **Arm 60s**, lock, tap **Reply**, dictate a sentence                          | Dictation reaches the phone                     | Result quotes your sentence                           |
| 6   | iPhone Settings → Wi-Fi **off** (not Control Center), repeat 4                | Does it work over the cloud relay?              | `path relay`                                          |
| 7   | **Arm 60s**, swipe Orca out of the app switcher, lock, tap **Yes**            | Cold launch: app not in memory                  | Prediction: no result; after reopening, a `stale` row |

Why 60s: iOS keeps "when unlocked" keychain items readable briefly after locking, so a 15s test can
pass by accident.

Turn **Pairing readable while locked** back **Off** when you're done, or leave it On if test 4 is the
behavior we want.

## 5. Reading the results

The Troubleshoot section has two lists. Tap **Refresh results** after each test.

**Results** (one row per tap that reached JS):

- `reached` / `failed` / `stale`, total ms, `app background|active`
- `native→JS ms`: from iOS delivering the tap to JS handling it
- steps: `protected-data true|false` (false = phone locked, keychain class unavailable),
  `keychain ready|temporarily-unavailable|missing`, `host-answer lan|tailscale|relay`
- the last connection-log lines when the host step fails

**Native timeline** (written by Swift, even when JS never ran):

- `launch background|active`: iOS launched the app
- `response <action> protected=…`: iOS delivered the tap
- `hold-started bg Ns` / `hold-ended js-done|expired Nms`: background time used

How to read test 7: a `launch background` plus a `response` with **no matching result** means iOS woke the
app but no JS ran. React Native only starts when a UI scene connects (`plugins/ios-scene-lifecycle.js`).
A `stale` row after you reopen the app means the tap was replayed late, which production must never act on.

## 6. What to send back

For each test: the Watch result text, plus one screenshot of the Results and Native timeline lists
after test 7. Note anything odd: buttons missing on the Watch, the dictation UI, Double Tap firing
the wrong button.

## 7. Decisions this unblocks

- **Test 4 passes:** move pairing items to `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` in
  `mobile/src/transport/hosts/pairing-keychain.ts`, with a migration (`setItemAsync` never changes an
  existing item's accessibility).
- **Test 7 fails as predicted:** a production tap needs either a native Swift handler for the response
  (E2EE + relay in Swift) or a way to start React Native when iOS relaunches the app in the background.
  That's the next spike.
- **All pass:** real build order: push `category` and prompt identity in
  `cloud/packages/push-contract/src/send-messages.ts` and `cloud/apps/push/src/apns-client.ts` →
  `agentSession.respondToApproval` for native chat → a host-checked terminal approval.
