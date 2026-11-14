package expo.modules.twowayaudio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.annotation.RequiresApi
import java.util.concurrent.Executors
import kotlin.math.pow


// The microphone rate; on-device speech requires it too.
internal const val MIC_SAMPLE_RATE = 16000

class AudioEngine (context: Context) {
    private val SAMPLE_RATE = MIC_SAMPLE_RATE
    private val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    private val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO

    private lateinit var audioRecord: AudioRecord
    private lateinit var audioManager: AudioManager
    private var audioFocusRequest: AudioFocusRequest? = null
    private var audioFocusChangeListener: AudioManager.OnAudioFocusChangeListener? = null
    private var audioDeviceCallback: android.media.AudioDeviceCallback? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private val executorServiceMicrophone = Executors.newFixedThreadPool(1)
    private var speakerDevice: AudioDeviceInfo? = null
    private var bridgeWindowStartedAtMs = System.currentTimeMillis()
    private var micEvents = 0
    private var micBytes = 0L

    // Read by the mic tap loop; written on the main (focus loss, pause), JS and tap threads.
    @Volatile
    var isRecording = false

    var onMicDataCallback: ((ByteArray) -> Unit)? = null
    var onInputVolumeCallback: ((Float) -> Unit)? = null
    var onAudioInterruptionCallback: ((String) -> Unit)? = null

    init {
        initializeAudio(context)
    }

    private fun flushBridgeStats(reason: String) {
        val now = System.currentTimeMillis()
        val elapsedMs = now - bridgeWindowStartedAtMs
        if (elapsedMs < 1000) {
            return
        }
        Log.d(
            "AudioEngine",
            "[bridge] $reason mic=${micEvents}ev/${micBytes}B windowMs=$elapsedMs"
        )
        bridgeWindowStartedAtMs = now
        micEvents = 0
        micBytes = 0
    }

    @SuppressLint("NewApi")
    private fun initializeAudio(context:Context) {
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        requestAudioFocus()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // Prefer connected outputs, falling back to speaker; AudioDeviceInfo/getDevices require API 23 (module floor: 21).
            updateAudioRouting()

            val callback = object:android.media.AudioDeviceCallback(){
                override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
                    Log.d("AudioEngine", "onAudioDevicesAdded")
                    super.onAudioDevicesAdded(addedDevices)
                    updateAudioRouting()
                }
                override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
                    Log.d("AudioEngine", "onAudioDevicesRemoved")
                    super.onAudioDevicesRemoved(removedDevices)
                    updateAudioRouting()
                }
            }
            audioDeviceCallback = callback
            audioManager.registerAudioDeviceCallback(callback, null)
        } else {
            updateLegacyAudioRouting()
        }
    }

    @RequiresApi(Build.VERSION_CODES.M)
    private fun updateAudioRouting() {
        val devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        var isExternalDeviceConnected = false
        var selectedDevice: AudioDeviceInfo? = null

        for (device in devices) {
            if (device.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                speakerDevice = device
            }
            if (device.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                device.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                device.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
                isExternalDeviceConnected = true
                selectedDevice = device
                break
            } else if (device.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                selectedDevice = device
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                selectedDevice?.let {
                    audioManager.setCommunicationDevice(it)
                }
            }catch (e:Exception){
                Log.e("AudioEngine", "Error setting communication device. Using speaker")
                speakerDevice?.let {
                    audioManager.setCommunicationDevice(it)
                }
            }

        } else {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = !isExternalDeviceConnected
        }
    }

    @Suppress("DEPRECATION")
    private fun updateLegacyAudioRouting() {
        val isExternalDeviceConnected =
            audioManager.isWiredHeadsetOn ||
                audioManager.isBluetoothScoOn ||
                audioManager.isBluetoothA2dpOn
        audioManager.isSpeakerphoneOn = !isExternalDeviceConnected
    }

    @SuppressLint("NewApi")
    private fun requestAudioFocus() {
        // Every resume re-requests; without abandoning first the previous listener stays on the focus stack.
        abandonAudioFocus()

        val listener = AudioManager.OnAudioFocusChangeListener { focusChange ->
            // Calls, alarms and assistants take focus transiently but hold the mic meanwhile; a duck request only lowers output we never play.
            when (focusChange) {
                AudioManager.AUDIOFOCUS_LOSS -> endRecordingForInterruption("blocked")
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> endRecordingForInterruption("began")
            }
        }
        audioFocusChangeListener = listener

        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val focusRequest =
                AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build()
                    )
                    .setAcceptsDelayedFocusGain(true)
                    .setOnAudioFocusChangeListener(listener)
                    .build()

            audioFocusRequest = focusRequest
            audioManager.requestAudioFocus(focusRequest)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                listener,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
            )
        }

        if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            throw RuntimeException("Audio focus request failed")
        }
    }

    @SuppressLint("NewApi")
    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            audioFocusRequest = null
        } else {
            @Suppress("DEPRECATION")
            audioFocusChangeListener?.let { audioManager.abandonAudioFocus(it) }
        }
        audioFocusChangeListener = null
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    @SuppressLint("MissingPermission")
    @Synchronized
    private fun startRecording(){
        val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        audioRecord = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            SAMPLE_RATE,
            CHANNEL_CONFIG,
            AUDIO_FORMAT,
            bufferSize
        )

        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
            throw RuntimeException("Audio Record can't initialize!")
        }

        if (AcousticEchoCanceler.isAvailable()){
            echoCanceler = AcousticEchoCanceler.create(audioRecord.audioSessionId)
            if (echoCanceler != null) {
                echoCanceler?.enabled = true
                Log.i("AudioEngine", "Echo Canceler enabled")
            }
        }

        if (NoiseSuppressor.isAvailable()){
            noiseSuppressor = NoiseSuppressor.create(audioRecord.audioSessionId)
            if (noiseSuppressor != null) {
                noiseSuppressor?.enabled = true
                Log.i("AudioEngine", "Noise Suppressor enabled")
            }
        }

        audioRecord.startRecording()
        isRecording = true
        startMicSampleTap()
    }

    private fun startMicSampleTap(){
        executorServiceMicrophone.execute {
            val buffer = ByteArray(1024)
            try {
                while (isRecording) {
                    val read = audioRecord.read(buffer, 0, buffer.size)
                    if (read > 0) {
                        val data = buffer.copyOf(read)
                        micEvents += 1
                        micBytes += data.size.toLong()
                        flushBridgeStats("mic")
                        val micVolume = calculateRMSLevel(data)
                        onInputVolumeCallback?.invoke(micVolume)
                        onMicDataCallback?.invoke(data)
                    }
                }
                Log.d("AudioEngine", "Mic sample tap stopped.")
            }catch (e: Exception){
                Log.e("AudioEngine", "Error reading mic sample data", e)
                isRecording = false
                tearDown()
                throw e
            }
        }
    }

    @Synchronized
    private fun stopRecording() {
        if (!isRecording) return
        isRecording = false
        if (audioRecord.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
            audioRecord.stop()
            audioRecord.release()
        }
        onInputVolumeCallback?.invoke(0.0F)
    }

    // Stop for good and let JS finish with what was heard; reopening later would splice a silent gap into the dictation.
    @Synchronized
    private fun endRecordingForInterruption(kind: String) {
        if (!isRecording) return
        Log.d("AudioEngine", "Recording interrupted: $kind")
        stopRecording()
        abandonAudioFocus()
        onAudioInterruptionCallback?.invoke(kind)
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    fun toggleRecording(value: Boolean): Boolean {
        if (value) {
            if (!isRecording) startRecording()
        } else {
            stopRecording()
        }
        return isRecording
    }

    fun bypassVoiceProcessing(bypass: Boolean) {
        if (bypass) {
            echoCanceler?.enabled = false
            noiseSuppressor?.enabled = false
        } else {
            echoCanceler?.enabled = true
            noiseSuppressor?.enabled = true
        }
    }

    // Recording in the background is not supported, so leaving the app interrupts it.
    fun endRecordingForPause() {
        endRecordingForInterruption("began")
    }

    fun regainAudioFocus() {
        requestAudioFocus()
    }

    @SuppressLint("NewApi")
    fun tearDown() {
        stopRecording()
        echoCanceler?.release()
        echoCanceler = null
        noiseSuppressor?.release()
        noiseSuppressor = null
        audioManager.mode = AudioManager.MODE_NORMAL
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            audioDeviceCallback?.let { audioManager.unregisterAudioDeviceCallback(it) }
            audioDeviceCallback = null
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
        }
        abandonAudioFocus()
        executorServiceMicrophone.shutdownNow()
    }


    private fun calculateRMSLevel(buffer: ByteArray): Float {
        val epsilon = 1e-5f // To avoid log(0)
        val sampleCount = buffer.size / 2
        var sumSquares = 0.0f
        for (i in 0 until sampleCount) {
            // Preserve signed-byte decoding without allocating a sample array per audio buffer.
            val sample = (buffer[i * 2].toInt() or (buffer[i * 2 + 1].toInt() shl 8)).toShort()
            val normalizedSample = sample / 32768.0f
            sumSquares += normalizedSample * normalizedSample
        }

        val rmsValue = kotlin.math.sqrt(sumSquares / sampleCount)

        val dbValue = 20 * kotlin.math.log10(maxOf(rmsValue, epsilon))

        // Normalize the assumed audible range [-80, 0] dB.
        val minDb = -80.0f
        val normalizedValue = maxOf(0.0f, minOf(1.0f, (dbValue - minDb) / kotlin.math.abs(minDb)))

        val expFactor = 2.0f
        val adjustedValue = normalizedValue.pow(expFactor)

        return adjustedValue
    }

}
