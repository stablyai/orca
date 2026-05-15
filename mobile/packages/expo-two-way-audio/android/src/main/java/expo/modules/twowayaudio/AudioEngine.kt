package expo.modules.twowayaudio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.annotation.RequiresApi
import java.util.Queue
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.pow


class AudioEngine (context: Context) {
    private val SAMPLE_RATE = 16000
    private val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    private val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO

    private lateinit var audioRecord: AudioRecord
    private lateinit var audioManager: AudioManager
    private lateinit var audioTrack: AudioTrack
    private var audioFocusRequest: AudioFocusRequest? = null
    private var audioFocusChangeListener: AudioManager.OnAudioFocusChangeListener? = null
    private var audioDeviceCallback: android.media.AudioDeviceCallback? = null
    private val audioSampleQueue: Queue<ByteArray> = ConcurrentLinkedQueue()
    private val playbackRunning = AtomicBoolean(false)
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private val executorServiceMicrophone = Executors.newFixedThreadPool(1)
    private val executorServicePlayback = Executors.newFixedThreadPool(1)
    private var speakerDevice: AudioDeviceInfo? = null
    private var bridgeWindowStartedAtMs = System.currentTimeMillis()
    private var micEvents = 0
    private var micBytes = 0L
    private var playbackEvents = 0
    private var playbackQueuedBytes = 0L
    private var playbackWrites = 0
    private var playbackWriteBytes = 0L

    var isRecording = false
    private var isRecordingBeforePause = false
    var isPlaying = false

    // Callbacks
    var onMicDataCallback: ((ByteArray) -> Unit)? = null
    var onInputVolumeCallback: ((Float) -> Unit)? = null
    var onOutputVolumeCallback: ((Float) -> Unit)? = null
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
            "[bridge] $reason mic=$micEvents" +
                "ev/${micBytes}B playbackQueue=$playbackEvents" +
                "ev/${playbackQueuedBytes}B playbackWrites=$playbackWrites" +
                "ev/${playbackWriteBytes}B windowMs=$elapsedMs"
        )
        bridgeWindowStartedAtMs = now
        micEvents = 0
        micBytes = 0
        playbackEvents = 0
        playbackQueuedBytes = 0
        playbackWrites = 0
        playbackWriteBytes = 0
    }

    @SuppressLint("NewApi")
    private fun initializeAudio(context:Context) {
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        requestAudioFocus()

        // Route audio to external device if connected, otherwise route to speaker
        updateAudioRouting()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // Listen for changes in audio routing
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
        }

        val bufferSize = AudioTrack.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AUDIO_FORMAT
        )

        audioTrack = AudioTrack(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
            AudioFormat.Builder()
                .setEncoding(AUDIO_FORMAT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build(),
            bufferSize,
            AudioTrack.MODE_STREAM,
            audioManager.generateAudioSessionId()
        ).apply {
            play()
        }
    }

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
            // Use the modern API for Android S and above
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
            // Fall back to deprecated method for older Android versions
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = !isExternalDeviceConnected
        }
    }

    @SuppressLint("NewApi")
    private fun requestAudioFocus() {
        val listener = AudioManager.OnAudioFocusChangeListener { focusChange ->
            when (focusChange) {
                AudioManager.AUDIOFOCUS_LOSS -> {
                    Log.d("AudioEngine", "Audio focus lost")
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        pauseRecordingAndPlayer()
                    } else {
                        stopRecording()
                        stopPlayback()
                    }
                    onAudioInterruptionCallback?.let { it("blocked") }
                }
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

    @RequiresApi(Build.VERSION_CODES.Q)
    @SuppressLint("MissingPermission")
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

    private fun stopRecording() {
        if (!isRecording) return
        isRecording = false
        if (audioRecord.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
            audioRecord.stop()
            audioRecord.release()
        }
        onInputVolumeCallback?.invoke(0.0F)
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    fun toggleRecording(value: Boolean): Boolean {
        if (value == isRecording) return isRecording

        if (value) {
            startRecording()
        } else {
            stopRecording()
        }

        isRecording = value
        return isRecording
    }

    fun playPCMData(data: ByteArray) {
        audioSampleQueue.add(data)
        playbackEvents += 1
        playbackQueuedBytes += data.size.toLong()
        Log.d(
            "AudioEngine",
            "playPCMData queued bytes=${data.size} queueSize=${audioSampleQueue.size} " +
                "head=${data.take(12).joinToString(" ") { byte -> "%02x".format(byte.toInt() and 0xff) }}"
        )
        flushBridgeStats("queue")
        if (playbackRunning.compareAndSet(false, true)) {
            playAudioFromSampleQueue()
        }
    }

    private fun playAudioFromSampleQueue() {
        executorServicePlayback.execute{
            isPlaying = true
            try {
                while (true){
                    val data = audioSampleQueue.poll() ?: break
                    playSample(data)
                    val audioVolume = calculateRMSLevel(data)
                    onOutputVolumeCallback?.invoke(audioVolume)
                }
            }catch (e: Exception){
                Log.e("AudioEngine", "Error playing audio", e)
                e.printStackTrace()
            }finally {
                playbackRunning.set(false)
                isPlaying = false
                onOutputVolumeCallback?.invoke(0.0F)
                if (audioSampleQueue.isNotEmpty() && playbackRunning.compareAndSet(false, true)) {
                    playAudioFromSampleQueue()
                }
            }
        }
    }

    private fun playSample(data: ByteArray) {
        val written = audioTrack.write(data, 0, data.size)
        playbackWrites += 1
        playbackWriteBytes += written.coerceAtLeast(0).toLong()
        Log.d(
            "AudioEngine",
            "playSample wrote=$written requested=${data.size} playState=${audioTrack.playState} " +
                "queueSize=${audioSampleQueue.size}"
        )
        flushBridgeStats("write")
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

    @RequiresApi(Build.VERSION_CODES.Q)
    fun pauseRecordingAndPlayer() {
        isRecordingBeforePause = isRecording
        isRecording = toggleRecording(false)
        audioTrack.pause()
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    fun resumeRecordingAndPlayer() {
        requestAudioFocus()
        isRecording = toggleRecording(isRecordingBeforePause)
        audioTrack.play()
    }

    fun stopPlayback() {
        audioSampleQueue.clear()
        audioTrack.pause()
        audioTrack.flush()
        playbackRunning.set(false)
        isPlaying = false
        onOutputVolumeCallback?.invoke(0.0F)
        Log.d("AudioEngine", "Playback stopped")
    }

    fun pausePlayback() {
        audioTrack.pause()
        Log.d("AudioEngine", "Playback paused")
    }

    fun resumePlayback() {
        audioTrack.play()
        Log.d("AudioEngine", "Playback resumed")
    }

    @SuppressLint("NewApi")
    fun tearDown() {
        stopRecording()
        if (::audioTrack.isInitialized) {
            audioTrack.stop()
            audioTrack.release()
        }
        echoCanceler?.release()
        echoCanceler = null
        noiseSuppressor?.release()
        noiseSuppressor = null
        audioSampleQueue.clear()
        playbackRunning.set(false)
        audioManager.mode = AudioManager.MODE_NORMAL
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            audioDeviceCallback?.let { audioManager.unregisterAudioDeviceCallback(it) }
            audioDeviceCallback = null
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { request ->
                audioManager.abandonAudioFocusRequest(request)
            }
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(audioFocusChangeListener)
        }
        executorServiceMicrophone.shutdownNow()
        executorServicePlayback.shutdownNow()
    }


    private fun calculateRMSLevel(buffer: ByteArray): Float {
        val epsilon = 1e-5f // To avoid log(0)

        // Convert ByteArray to FloatArray by treating each pair of bytes as a single 16-bit PCM sample
        val floatBuffer = FloatArray(buffer.size / 2)
        for (i in floatBuffer.indices) {
            // Combine two bytes into a 16-bit signed integer
            val sample = (buffer[i * 2].toInt() or (buffer[i * 2 + 1].toInt() shl 8)).toShort()
            // Normalize sample to -1.0 to 1.0 range for FloatArray
            floatBuffer[i] = sample / 32768.0f
        }

        // Calculate RMS value
        val rmsValue = kotlin.math.sqrt(floatBuffer.fold(0f) { acc, sample -> acc + sample * sample } / floatBuffer.size)

        // Convert to decibels
        val dbValue = 20 * kotlin.math.log10(maxOf(rmsValue, epsilon))

        // Normalize decibel value to 0-1 range
        // Assuming minimum audible is -80dB and maximum is 0dB
        val minDb = -80.0f
        val normalizedValue = maxOf(0.0f, minOf(1.0f, (dbValue - minDb) / kotlin.math.abs(minDb)))

        // Optional: Apply exponential factor to push smaller values down
        val expFactor = 2.0f // Adjust this value to change the curve
        val adjustedValue = normalizedValue.pow(expFactor)

        return adjustedValue
    }

}
