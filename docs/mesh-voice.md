# Mesh Voice

## Problem

Mesh TTS speak-back is the operator's way to keep hands on the keyboard
while still hearing an answer. The fork's voice arc lands five sharp
fixes / features:

- **TTS was playing into the earpiece, not the speaker.** The mesh was
  fine, the app was fine, and the audio was being consumed by the
  AudioTrack. It was just routed to the wrong output. Verified on a
  Nord N10 5G (Android 14) — `dumpsys audio` showed the wrong stream.
- **Session speak-back never fired.** `sendRequest` resolved the RPC
  envelope (`{ ok, result, _meta }`), not the payload.
  `useSessionSpeakBack` read `res.worktrees` off the envelope → always
  `undefined` → zero agent rows inspected → speak-back never fired
  with no error anywhere. The host panel worked because it speaks from
  the screen's already-fetched array instead.
- **Watcher was scoped per-screen, not per-workspace.** A global mode
  bound to one screen dies the moment the screen unmounts, even though
  the workspace it was armed for is still on screen elsewhere.
- **Polling collapsed under Doze / App Standby.** Speak-back watched
  `worktree.ps` on a 4s interval. Android throttles JS timers hard
  under Doze/App Standby — gaps stretched from 4s to 62s while
  backgrounded, so a finished turn could be spoken a minute late.
- **Desktop had no TTS at all.** The feature lived only under
  `mobile/src/voice/`. A desktop pet answered in its bubble silently,
  and the operator's flow (finish a turn, hear a summary, then
  optionally open the terminal) stopped one step short.

## Goal

- Speak-back works on desktop and on mobile, with the same per-surface
  on/off the phone already had.
- The toggle lives in one place across views — left chrome, not a
  per-tab titlebar strip that gets rebuilt.
- The watcher is keyed by `hostId::worktreeId`, not by screen.
- Speak-back fires on the completion push, not a throttled poll.
- The Kokoro voice picker lists live voices from the mesh's TTS
  endpoint, not a hardcoded catalogue that can drift from what is
  actually installed.
- Audio routes to the speaker, not the earpiece.

## Non-goals

- Replacing the mobile app's `mobile/src/voice/` modules. They remain
  the origin; the desktop implementation restates the constants in
  `src/renderer/src/lib/voice/mesh-speech-config.ts` with a pointer
  back to `mobile/src/voice/mesh-voice-turn.ts` because mobile is a
  separate build with its own aliases.
- Adding a new IPC channel. The desktop subscribe path uses
  `agentStatusByPaneKey` from the renderer store, which is the same
  data the desktop already holds.
- Replacing the TTS provider. Kokoro on node-a (`MESH_VOICE_BASE_URL`
in `src/renderer/src/lib/voice/mesh-speech-config.ts`) is the canonical audio path; the picker
  is a UI over that provider, not a second provider.
- Voice activity detection / barge-in. Speak-back is one-way.

## Implementation

### Audio routing fix — `52fdbfe3`

The native bridge counters confirmed the audio arrived and was being
consumed (`queue 1ev/69982B`, `windowMs=2233`), while `dumpsys audio`
showed the wrong stream. The bridge now requests the speaker stream
explicitly rather than letting Android pick the earpiece by default.
`mobile/src/voice/use-mesh-speak.ts` is the file most affected.

### Session speak-back never fired — `02629d9a`

`useSessionSpeakBack` now reads `res.result.worktrees` instead of
`res.worktrees`, and the hop is commented so it does not regress into
the silent no-op the bug report flagged. Two structural changes ride
along:

- **Watcher is hoisted.** The provider moved out of the screen into
  `SpeakBackProvider` above the navigator, keyed by armed
  `hostId::worktreeId`. Leaving the session screen no longer kills
  it. One watcher component per armed workspace keeps the hook rules
  intact. Still bounded by the app being foregrounded; background
  speaking wants the notification channel, not a longer timer.
- **Mesh voice picker.** Catalogue is fetched live from Kokoro (67
  voices, reachable from the Nord in ~400 ms) rather than hardcoded,
  so it cannot drift from what is installed. Falls back to a small
  known-good spread when unreachable so the picker is never empty.
  LiteLLM `:4000` does not expose the model catalogue; the picker
  hits Kokoro directly.

### Speak on the completion push, not the throttled poll — `dd9cbae2`

Speak-back now subscribes to the completion push event instead of a
4s `worktree.ps` poll. Doze/App Standby stretch gaps from 4s to 62s
on the Nord; the push event is not subject to that throttling. The
4s poll is kept as a fallback only for hosts that have not yet
shipped the push event.

### Desktop port with titlebar on/off — `e3ed74c8`

The fetch halves moved over unchanged in spirit:

- `summarize-for-speech` is the same compression prompt and
  verbatim-under-220-chars shortcut.
- `synthesizeViaMesh` hits the same node-a Kokoro route.

Playback is the one piece that could not port — mobile uses
`expo-two-way-audio`'s `playPCMData`, which does not exist on
desktop — so `DesktopMeshSpeaker` decodes the same 16-bit PCM into a
Web Audio buffer instead. No resample step: mobile downsamples to 16k
only because its native player wants 16k, while Web Audio plays
Kokoro's native 24k directly (`KOKORO_SAMPLE_RATE = 24000` in
`src/renderer/src/lib/voice/mesh-speech-config.ts`).

The watch loop also simplified: mobile polls `worktree.ps` over RPC
and has to unwrap the response envelope (the trap that once shipped
it silently broken). The renderer already holds the same status in
`agentStatusByPaneKey`, so the desktop subscribes to the store
instead. The `src/renderer/src/lib/voice/desktop-speak-back-detect.ts` module is the per-surface
on/off signal; `src/renderer/src/lib/voice/desktop-speak-back-store.ts` is the per-host /
per-worktree state; `src/renderer/src/lib/voice/use-desktop-session-speak-back.ts` is the hook.

### Toggle to the left chrome — `e7f0e82c`

The toggle lived in the right titlebar strip, which is rebuilt per
view, so it moved around and vanished on some tabs. Speak-back is a
global mode, not a per-tab control, so it belongs in the one chrome
present on every view: pinned just right of the sidebar toggle,
styled to match it, where the operator can always find it in the
same spot. `src/renderer/src/App.tsx` mounts it; the component is
`src/renderer/src/components/voice/SpeakBackToggle.tsx`.

## Verification

- `src/renderer/src/lib/voice/desktop-speak-back-detect.test.ts` — per-surface on/off signal,
  per-host / per-worktree state, completion push subscription.
- `src/renderer/src/lib/voice/mesh-speech-config.ts` carries the constants; restating them is
  the integration surface, so the file is the contract for "the
  desktop and mobile agree on the endpoint, the model, the sample
  rate, and the default voice".
- Live: on a real Kokoro on node-a, the picker lists the same
  catalogue the mobile picker lists; the desktop toggle arms the
  same watcher the mobile screen armed; completion push fires
  within the same 1.5s budget on both surfaces.
- Audio routing: `dumpsys audio` after a fix-triggered speak shows
  the speaker stream, not the earpiece.

## In-flight

- T1 (mobile) / T2 (desktop) — both surfaces have working speak-back
  today, but T1 and T2 are the operator's next asks (idle-state
  follow-up turn, persistent workspace toggle across screens). They
  are tracked in meshina, not in this repo.