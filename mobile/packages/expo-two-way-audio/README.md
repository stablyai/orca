# Speechmatics Two Way Audio

Expo module for capturing and playing pcm audio data in react-native apps (iOS and Android).

The aim of the module is to facilitate creating real-time conversational apps. The following features are provided:

- Request audio recording permissions
- Get clean (applying Acoustic Echo Cancelling) microphone samples in PCM format (1 channel 16 bit at 16kHz)
- Play audio samples in PCM format (1 channel 16 bit at 16kHz). Playback happens through main speaker unless external audio sources are connected.
- Provide volume level both for the input and output samples. Float between 0 and 1.
- [iOS only] Get microphone mode and prompt user to select a microphone mode.

Check out our [examples/](./examples) to see the module in action.

## Installation

```
npm i @speechmatics/expo-two-way-audio
```

## Usage

Please check out our [examples/](./examples) to get full sample code.

1. Request permissions for recording audio

   ```JSX
   import {useMicrophonePermissions} from "@speechmatics/expo-two-way-audio";

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

1. Play audio

   > [!NOTE]
   > The sample below uses the `buffer` module:
   > `npm install buffer`

   ```JSX
    import { Buffer } from "buffer";

    // As an example, let's play pcm data hardcoded in a variable.
    // The examples/basic-usage does this. Check it out for real base64 data.
    const audioChunk = "SOME PCM DATA BASE64 ENCODED HERE"
    const buffer = Buffer.from(audioChunk, "base64");
    const pcmData = new Uint8Array(buffer);
    playPCMData(pcmData);
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

Some audio features of expo-two-way-audio like Acoustic Echo Cancelling, noise reduction or microphone modes (iOS) don't work on simulator. Run the example on a real device to test these features.

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
