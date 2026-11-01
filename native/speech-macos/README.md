# macOS dictation helper

`pnpm build:speech-macos` compiles a universal Swift helper. The macOS development
launcher builds the host architecture and places it beside Electron; packaged
builds ship it in `Contents/MacOS`. Xcode 26 or newer with the macOS 26 SDK is required.
The app continues to support older macOS versions, but this engine is only offered
on macOS 26 and newer. Hardware and locale support are checked by the helper.
Hosts without the bundled helper do not offer this engine. Existing mobile clients
cannot represent system-managed engines, so it is omitted from their model list;
if desktop settings select it, mobile dictation asks the user to choose a supported
model instead. Parakeet and OpenAI remain available to mobile clients.

The helper recognizes a private temporary WAV through `SpeechAnalyzer` and
`SpeechTranscriber`, using the system locale and the `.transcription` preset.
Selecting the engine requests installation of missing language assets through
Apple's `AssetInventory`; macOS owns and updates these assets. Orca does not store
or delete the models. Installation has a separate ten-minute timeout and must
finish before the engine is selected. Recognition never downloads assets or sends
audio to a server. Buffered sessions are capped at ten minutes to bound memory,
and recognition has a 55-second timeout. Temporary audio is removed on success
or failure. Unsupported hardware, locales, and missing assets produce errors.

## macOS validation

1. On macOS 26+, run `ORCA_BACKGROUND_LAUNCH=1 pnpm dev` on an isolated display.
2. Enable voice dictation and select **macOS Speech**. No model download or delete
   controls should appear for this engine.
3. Let macOS install language assets if needed. Grant microphone permission, dictate using the existing
   shortcut, stop, and check that the final text is inserted.
4. Deny microphone permission in System Settings and repeat. Check that
   an actionable error appears and no transcription is inserted.
5. Test a supported language without installed assets: selection should install
   them. Then disconnect networking and verify recognition. An unsupported language
   or device should produce an error without falling back to another recognizer.
6. Switch back to Parakeet or an OpenAI model and verify existing dictation.
7. Verify this engine is absent on macOS 15 and earlier, Windows, and Linux.
8. Test recordings longer than one minute, repeated sessions, silence, and the
   installed packaged app. Check temporary audio cleanup on success and failure.

Swift compilation, TCC attribution, signing, real audio recognition, and the
packaged app must be validated on macOS; Linux unit tests cannot establish these.
