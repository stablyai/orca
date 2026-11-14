# Orca Two Way Audio

Vendored Expo module for capturing PCM microphone audio in the Orca mobile app (iOS and Android). Orca uses it for voice dictation; the upstream playback path was removed because nothing played audio through it.

The following features are provided:

- Request audio recording permissions
- Get clean (applying Acoustic Echo Cancelling) microphone samples in PCM format (1 channel 16 bit at 16kHz)
- Provide the input volume level. Float between 0 and 1.
- [iOS only] Get microphone mode and prompt user to select a microphone mode.

## Installation

```
npm i @orca/expo-two-way-audio
```

## Usage

1. Request permissions for recording audio

   ```JSX
   import {useMicrophonePermissions} from "@orca/expo-two-way-audio";

   const [micPermission, requestMicPermission] = useMicrophonePermissions();
   console.log(micPermission);
   ```

1. Initialize the module before calling any audio functionality.

   ```JSX
   useEffect(() => {
       const initializeAudio = async () => {
           await initialize();
       };
       initializeAudio();
   }, []);

   ```

1. Get microphone samples

   ```JSX
   // Set up a function to deal with microphone sample events.
   // In this case just print the data in the console.
   useExpoTwoWayAudioEventListener(
       "onMicrophoneData",
       useCallback<MicrophoneDataCallback>((event) => {
           console.log(`MIC DATA: ${event.data}`);
       }, []),
   );

   // Unmute the microphone to get microphone data events
   toggleRecording(true);
   ```

## Notes

Some audio features of expo-two-way-audio like Acoustic Echo Cancelling, noise reduction or microphone modes (iOS) don't work on simulator. Run the Orca mobile app on a real device to test these features.

```bash
# iOS
npx expo run:ios --device --configuration Release

# Android
npx expo run:android --device --variant release
```

For Android, the following permissions are needed: `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`. In Expo apps they can bee added in your `app.json` file:

```javascript
expo.android.permissions: ["RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS"]
```
