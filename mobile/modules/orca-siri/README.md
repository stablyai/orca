# Siri actions for Orca mobile (branch `CJNA/orca-siri`)

Ask about and answer Orca agents with Siri. This also works through CarPlay and while the iPhone is locked. Built on the Apple Watch spike (`CJNA/orca-applewatch`) and the locked-keychain fix (PR #42634, merged into this branch).

## Why it's built this way (lessons from the Watch spike)

| Watch finding                                                                                                | Consequence for Siri                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| A locked phone couldn't read pairing credentials (fixed in PR #42634: `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`) | Siri in CarPlay always runs while the phone is locked. The bridge config uses the same keychain setting. |
| When iOS launches the app in the background, React Native doesn't start (it only boots when a screen opens)  | The intents are plain Swift with no JavaScript                                                           |
| The app's paired connection tries direct routes for up to 20s before the relay                               | That's longer than Siri waits, so the intents use the HTTPS bridge instead (about 0.75s)                 |
| The Watch gets no network in background actions                                                              | Not a problem here: the iPhone has network inside an App Intent                                          |

```
Siri / CarPlay ─> App Intent (Swift, app target) ─HTTPS + Siri token─> watch-bridge.mjs (Mac, Tailscale Funnel)
                                                                        └─> Orca runtime socket + `orca terminal send`
```

## Pieces

| Piece                                                                                                      | Path                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Shared Swift (models, keychain, HTTPS client, speech)                                                      | `modules/orca-siri/ios/` (pod `OrcaSiri`)                                                |
| Intents, agent entity, phrases                                                                             | `modules/orca-siri/app-target/OrcaAppIntents.swift`                                      |
| Copies the intents into the app target (Xcode only reads App Intents metadata there, not from static pods) | `plugins/ios-siri-app-intents.js`, enabled by `ORCA_SIRI=1` in `app.config.js`           |
| Setup UI (bridge URL and token, saved in the keychain)                                                     | `src/siri/SiriSetupRow.tsx`, under Settings → Troubleshoot, only in `ORCA_SIRI=1` builds |
| Bridge endpoints                                                                                           | `modules/orca-watch-action-spike/watch-bridge/watch-bridge.mjs`                          |

## Intents

| Intent              | Phrases                                | Does                                                                                                                |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Check Orca          | "Check Orca", "What's waiting in Orca" | Speaks the newest prompt, then offers Approve / Deny / Reply / Cancel (`requestChoice`). Reply asks you to dictate. |
| Approve Orca Prompt | "Approve in Orca"                      | Speaks what will run and asks you to confirm, then sends a plain **Yes**                                            |
| Orca Agent Status   | "Orca status", "What's Orca doing"     | State and last words, newest 3 agents                                                                               |
| Message Orca Agent  | "Message Orca app"                     | Asks which agent, then sends dictated text to one that's done or waiting. Busy or exited agents are refused.        |

- Say "Orca **app**" with Message or Tell. Otherwise Siri looks for a contact named Orca.
- Phrases with `{agent}` don't match yet: the app never calls `updateAppShortcutParameters()`. Siri asks which agent instead.

- Every intent uses `authenticationPolicy = .alwaysAllowed`. Approving with a locked phone is intended.
- Siri never chooses a "Yes, and …" option. Those change Claude's mode for the rest of the session.
- The intents are marked `@available(iOS 26.0, *)` because `requestChoice` needs iOS 26. CarPlay voice apps need 26.4 anyway.

## Bridge API (Siri token `~/.orca/siri-bridge-token`)

- `GET /siri/v1/overview` returns `{ prompts, agents }`.
  - Each agent has `id` (its pane key), `name`, `workspace`, `agentType`, `state`, `needsApproval`, `task` and `lastMessage`.
  - `task` and `lastMessage` are cleaned of markdown so they can be spoken.
- `POST /siri/v1/answer` with `{ promptId, decision: "option", optionId }` or `{ promptId, decision: "text", text }`.
  - The Siri token may only pick an option labelled exactly "Yes" or starting with "No"; anything else returns 403. The Watch token may pick any option, because the Watch asks for a second tap first.
  - The terminal is re-read just before the key is typed, and the dialog must match the one that was listed (409 if not).
  - `{ confirmed: false }` means the key went in but the prompt hadn't left within about 3 s. It isn't an error.
- The first `detail` line of each prompt is a short spoken action: a file name not a path, a host not a URL, the first command of a chain ("Bash: git branch --unset-upstream, and 2 more"). The Watch endpoint still gets the full detail.
- Folder workspaces (`folder:<uuid>`) get an empty `workspace`, so Siri never reads out an ID.
- `POST /siri/v1/message` with `{ agentId, text }`.
  - Returns 409 if the agent is working.
  - Returns 409 unless Claude's input box is on screen. Orca keeps a finished agent's status after Claude exits, and without this check the text would be typed into the shell.
  - On an approval prompt, it sends Esc first, then the text.
- **Token scopes:**
  - The Watch token (`~/.orca/watch-bridge-token`) can use prompts, answer and register.
  - The Siri token can use prompts, answer, agents and message.
  - Calling outside your scope returns 403.
- **Rate limit:** each token gets 20 writes per minute. Over the limit returns 429.
- **Deadlines:** a write that can't start within 7 s of a Siri request (15 s for the Watch) returns 504 and types nothing, so an answer never lands after the phone or Watch already gave up.

## Setup

1. **Install the new bridge on the Mac.** `launchd` runs a copy, so copy the new script over and restart the service:
   ```bash
   cp modules/orca-watch-action-spike/watch-bridge/*.mjs ~/.orca/watch-bridge/
   launchctl kickstart -k gui/$(id -u)/com.cjna.orca-watch-bridge
   ```
   The Siri token is created on first start at `~/.orca/siri-bridge-token`.
2. **Build the app:**
   ```bash
   cd mobile && ORCA_SIRI=1 npx expo run:ios --device --configuration Release
   ```
   - Or use `modules/orca-siri/install-siri-build.sh --clean`. It builds under `com.<user>.orca.mobile`, picks the connected iPhone and checks the build has the intents. Run it with no options to reinstall the last build, for example after deleting the app by mistake: both apps are named Orca.
   - Add `ORCA_IOS_BUNDLE_ID=...` to use your own team. Xcode must be signed in to that team (Settings → Accounts). Otherwise it falls back to a wildcard profile, which can't carry Push Notifications.
   - Add `ORCA_WATCH_SPIKE=1` too if you want the Watch test row.
   - If the install step fails with "error reading pair record", replug and unlock the phone, then install the built app: `xcrun devicectl device install app --device <udid> <DerivedData>/Build/Products/Release-iphoneos/Orca.app`.
3. **Connect the phone:** in Orca → Settings → Troubleshoot → **Siri bridge**, enter:
   - the Funnel URL (`https://<mac>.ts.net:8443`). Use the host name from `tailscale funnel status`. A Tailscale IP fails because the certificate only matches the name.
   - the token from `cat ~/.orca/siri-bridge-token`

   Then tap **Save and test**. A good result shows what Siri would say.

4. **Try it:** say "Hey Siri, check Orca" on the phone.
   - If Siri shows its answer without speaking it, set Settings → Siri → Siri Responses → **Prefer Spoken Responses**. CarPlay always speaks.
   - To get a prompt, run Claude with `claude --permission-mode default`. In auto mode it approves safe commands itself and nothing waits.
5. **CarPlay Simulator:** it comes in "Additional Tools for Xcode" (developer.apple.com/download/all), under `Hardware/`. Connect the iPhone by USB and unlock it.

## Verified on a device (iPhone 16 Pro, CarPlay Simulator 27.2)

- **Check Orca:** speaks the waiting prompt. Approve, Deny and Reply all work by voice, on the phone and in CarPlay.
- **Locked phone:** same results in CarPlay with the phone locked.
- **Approve:** sends option 1, the plain **Yes**. Four approvals in a row each moved Claude to its next step, and it stayed in manual mode.
- **Status** and **Message Orca app** work. The message showed up in the chosen Claude terminal.
- Round trip over Funnel: about 130 ms for an overview and 630 ms for an answer, including the check that Claude moved on.

## Verified earlier (without a device)

- `tsc` and `oxlint` are clean.
- The Swift typechecks for iOS 15.1 and 26, in Swift 5 and Swift 6 modes.
- Bridge end-to-end against a fake runtime and fake `orca` CLI:
  - overview works
  - the scope checks return 401 and 403
  - a busy agent returns 409
  - messages and approvals are confirmed
  - answering the same prompt twice returns 409
  - Esc is sent before the text on approval prompts
  - the 429 rate limit kicks in
- Swift decodes the real overview JSON. Sample speech: "1 prompt is waiting for you. 3 agents: 1 working, 1 waiting, 1 done." / "Fix login bug in api wants to use Bash: npm test."
- `ORCA_SIRI=1 expo prebuild` adds `OrcaAppIntents.swift` to the Orca app target. `pod install` succeeds.
- Full simulator `xcodebuild` (Xcode 27.1): **BUILD SUCCEEDED**. `Orca.app/Metadata.appintents` contains all 4 intents, `OrcaAgentEntity` and the 11 phrases.

## Still to do

- [x] Run "Hey Siri, check Orca" on a device with a locked phone, then in CarPlay Simulator.
- [x] Check whether `requestChoice` options can be spoken in CarPlay. They can, so no fallback is needed.
- [ ] Rename the Message and Tell phrases so they don't collide with Messages.
- [ ] Call `OrcaAppShortcuts.updateAppShortcutParameters()` after each overview, so "What is {agent} doing" matches agent names.
- [ ] Native chat (agent-session) tabs are not covered: only terminal agents are. Prompts still come from reading Claude's dialog off the terminal screen.
- [ ] The key that answers a prompt isn't conditional on the dialog: if the dialog changes between the bridge's last read and the key, the key lands on the new dialog. Closing that needs a conditional send in the runtime (`orca terminal send` has no prompt identity). Until then the window is one terminal read.
- [ ] Switching `ORCA_SIRI` off needs a fresh `ios/` (`npx expo prebuild --platform ios --clean`). `expo run:ios` reuses an existing `ios/` without running config plugins, and the plugin refuses to prebuild into an `ios/` that still has the intents.
- [ ] Next: a CarPlay voice-based conversational app (`com.apple.developer.carplay-voice-based-conversation`, iOS 26.4+, `CPVoiceControlTemplate`).
