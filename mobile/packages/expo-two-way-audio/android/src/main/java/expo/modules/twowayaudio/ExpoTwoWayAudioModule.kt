package expo.modules.twowayaudio

import androidx.core.os.bundleOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Coroutine
import expo.modules.interfaces.permissions.Permissions

class ExpoTwoWayAudioModule : Module() {
    companion object {
        private const val ON_MIC_DATA_EVENT = "onMicrophoneData"
        private const val ON_INPUT_VOLUME_LEVEL_EVENT = "onInputVolumeLevelData"
        private const val ON_RECORDING_CHANGE_EVENT = "onRecordingChange"
        private const val ON_AUDIO_INTERRUPTION_EVENT = "onAudioInterruption"
        var audioEngine: AudioEngine? = null
    }

    private val speechHandle = lazy {
        OnDeviceSpeech(requireNotNull(appContext.reactContext).applicationContext) { name, body ->
            sendEvent(name, body)
        }
    }
    private val speech by speechHandle

    override fun definition() = ModuleDefinition {
        Name("ExpoTwoWayAudio")
        AsyncFunction("initialize") { promise: Promise ->
            try {
                if (audioEngine != null) {
                    promise.resolve(true)
                    return@AsyncFunction
                }
                audioEngine = appContext.reactContext?.let { AudioEngine(it) }
                setupCallbacks()
                promise.resolve(true)
            } catch (e: Exception) {
                promise.resolve(false)
            }
        }

         Function("isRecording") {
             audioEngine?.isRecording ?: false
         }

         Function("toggleRecording") { value: Boolean ->
             audioEngine?.let { engine ->
                 val isRecording = engine.toggleRecording(value)
                 sendEvent(ON_RECORDING_CHANGE_EVENT, mapOf("data" to isRecording))
                 isRecording
             } ?: false
         }

         Function("tearDown") {
             audioEngine?.tearDown()
             audioEngine = null
             null
         }

         Function("restart") {
             audioEngine?.resumeRecording()
             sendEvent(ON_RECORDING_CHANGE_EVENT, mapOf(
                 "data" to (audioEngine?.isRecording ?: false)
             ))
         }

         Function("bypassVoiceProcessing") { bypass: Boolean ->
             audioEngine?.bypassVoiceProcessing(bypass)
         }

        Function("getMicrophoneModeIOS") {
            throw UnsupportedOperationException("getMicrophoneModeIOS is only supported on iOS")
        }

        Function ("setMicrophoneModeIOS") {
            throw UnsupportedOperationException("setMicrophoneModeIOS is only supported on iOS")
        }

         AsyncFunction("getMicrophonePermissionsAsync") { promise: Promise ->
             Permissions.getPermissionsWithPermissionsManager(
                 appContext.permissions,
                 promise,
                 android.Manifest.permission.RECORD_AUDIO
             )
         }

         AsyncFunction("requestMicrophonePermissionsAsync") { promise: Promise ->
             // Asking when already granted still runs GrantPermissionsActivity, which pauses/resumes the React host.
             val permissionsManager = appContext.permissions
             if (permissionsManager?.hasGrantedPermissions(android.Manifest.permission.RECORD_AUDIO) == true) {
                 Permissions.getPermissionsWithPermissionsManager(
                     permissionsManager,
                     promise,
                     android.Manifest.permission.RECORD_AUDIO
                 )
             } else {
                 Permissions.askForPermissionsWithPermissionsManager(
                     permissionsManager,
                     promise,
                     android.Manifest.permission.RECORD_AUDIO
                 )
             }
         }

        AsyncFunction("speechAvailability") Coroutine { locale: String ->
            speech.availability(locale)
        }

        AsyncFunction("speechDownload") Coroutine { locale: String ->
            speech.download(locale)
        }

        AsyncFunction("speechStart") Coroutine { locale: String, sampleRate: Int ->
            speech.start(locale, sampleRate)
        }

        Function("speechFeed") { pcm: ByteArray ->
            speech.feed(pcm)
        }

        AsyncFunction("speechFinish") Coroutine { ->
            speech.finish()
        }

        Function("speechCancel") {
            speech.cancel()
        }

        OnDestroy {
            if (speechHandle.isInitialized()) speech.destroy()
        }

        Events(
            ON_MIC_DATA_EVENT,
            ON_INPUT_VOLUME_LEVEL_EVENT,
            ON_RECORDING_CHANGE_EVENT,
            ON_AUDIO_INTERRUPTION_EVENT,
            SPEECH_TEXT_EVENT,
            SPEECH_ERROR_EVENT,
            SPEECH_DOWNLOAD_PROGRESS_EVENT
        )
    }

    private fun setupCallbacks() {
        audioEngine?.apply {
            onMicDataCallback = { data ->
                sendEvent(ON_MIC_DATA_EVENT, bundleOf("data" to data))
            }
            onInputVolumeCallback = { level ->
                sendEvent(ON_INPUT_VOLUME_LEVEL_EVENT, bundleOf("data" to level))
            }
            onAudioInterruptionCallback = { data ->
                sendEvent(ON_AUDIO_INTERRUPTION_EVENT, bundleOf("data" to data))
                sendEvent(ON_RECORDING_CHANGE_EVENT, bundleOf(
                    "data" to (audioEngine?.isRecording ?: false)
                ))
            }
        }
    }
}
