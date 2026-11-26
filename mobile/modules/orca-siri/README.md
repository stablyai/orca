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

| Intent              | Phrases                                              | Does                                                                                                                |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Check Orca          | "Check Orca", "What's waiting in Orca"               | Speaks the newest prompt, then offers Approve / Deny / Reply / Cancel (`requestChoice`). Reply asks you to dictate. |
| Approve Orca Prompt | "Approve in Orca"                                    | Speaks what will run and asks you to confirm, then sends a plain **Yes**                                            |
| Orca Agent Status   | "What's Orca doing", "What is {agent} doing in Orca" | State and last words, newest 3 agents                                                                               |
| Message Orca Agent  | "Tell Orca", "Message {agent} in Orca"               | Sends dictated text to an agent that's done or waiting. Busy agents are refused.                                    |

- Every intent uses `authenticationPolicy = .alwaysAllowed`. Approving with a locked phone is intended.
- Siri never chooses a "Yes, and …" option. Those change Claude's mode for the rest of the session.
- The intents are marked `@available(iOS 26.0, *)` because `requestChoice` needs iOS 26. CarPlay voice apps need 26.4 anyway.

## Bridge API (Siri token `~/.orca/siri-bridge-token`)

- `GET /siri/v1/overview` returns `{ prompts, agents }`.
  - Each agent has `id` (its pane key), `name`, `workspace`, `agentType`, `state`, `needsApproval`, `task` and `lastMessage`.
  - `task` and `lastMessage` are cleaned of markdown so they can be spoken.
- `POST /siri/v1/answer` with `{ promptId, decision: "option", optionId }` or `{ promptId, decision: "text", text }`.
- `POST /siri/v1/message` with `{ agentId, text }`.
  - Returns 409 if the agent is working.
  - On an approval prompt, it sends Esc first, then the text.
- **Token scopes:**
  - The Watch token (`~/.orca/watch-bridge-token`) can use prompts, answer and register.
  - The Siri token can use prompts, answer, agents and message.
  - Calling outside your scope returns 403.
- **Rate limit:** each token gets 20 writes per minute. Over the limit returns 429.

## Setup

1. **Install the new bridge on the Mac.** `launchd` runs a copy, so copy the new script over and restart the service:
   ```bash
   cp modules/orca-watch-action-spike/watch-bridge/watch-bridge.mjs ~/.orca/watch-bridge/
   launchctl kickstart -k gui/$(id -u)/com.cjna.orca-watch-bridge
   ```
   The Siri token is created on first start at `~/.orca/siri-bridge-token`.
2. **Build the app:**
   ```bash
   cd mobile && ORCA_SIRI=1 npx expo run:ios --device --configuration Release
   ```
   - Add `ORCA_IOS_BUNDLE_ID=...` to use your own team.
   - Add `ORCA_WATCH_SPIKE=1` too if you want the Watch test row.
3. **Connect the phone:** in Orca → Settings → Troubleshoot → **Siri bridge**, enter:
   - the Funnel URL (`https://<mac>.ts.net:8443`)
   - the token from `cat ~/.orca/siri-bridge-token`

   Then tap **Save and test**. A good result shows what Siri would say.

4. **Try it:** say "Hey Siri, check Orca" on the phone. Then try it in CarPlay Simulator (Xcode Device Hub, iPhone connected by USB).

## Verified so far (without a device)

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

## Still to do

- [ ] Check the result of the simulator `xcodebuild`: App Intents metadata extraction, and `import OrcaSiri` from the app target.
- [ ] Run "Hey Siri, check Orca" on a device with a locked phone, then in CarPlay Simulator.
- [ ] Check whether `requestChoice` options can be spoken in CarPlay, or whether a `requestConfirmation` fallback is needed.
- [ ] Native chat (agent-session) tabs are not covered: only terminal agents are. Prompts still come from reading Claude's dialog off the terminal screen.
- [ ] Next: a CarPlay voice-based conversational app (`com.apple.developer.carplay-voice-based-conversation`, iOS 26.4+, `CPVoiceControlTemplate`).
