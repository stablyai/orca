import ExpoModulesCore
import AVFoundation

let ON_MIC_DATA_EVENT_NAME = "onMicrophoneData"
let ON_INPUT_VOLUME_LEVEL_EVENT_NAME = "onInputVolumeLevelData"
let ON_RECORDING_CHANGE_EVENT_NAME = "onRecordingChange"
let ON_AUDIO_INTERRUPTION_EVENT_NAME = "onAudioInterruption"

public class ExpoTwoWayAudioModule: Module {
    private var audioEngine: AudioEngine?
    // OnDeviceSpeechController on iOS 26 and later; nil before, where every speech function answers unsupported.
    private var speech: AnyObject?
    public func definition() -> ModuleDefinition {
        Name("ExpoTwoWayAudio")

        OnCreate { [weak self] in
            guard let self else { return }
            let permissionsManager = self.appContext?.permissions
            EXPermissionsMethodsDelegate.register(
                [
                    MicrophonePermissionRequester()
                ],
                withPermissionsManager: permissionsManager
            )
            if #available(iOS 26.0, *) {
                self.speech = OnDeviceSpeechController { [weak self] name, body in
                    self?.sendEvent(name, body)
                }
            }

        }

        OnDestroy {
            guard #available(iOS 26.0, *) else { return }
            self.onDeviceSpeech()?.cancel()
        }

        AsyncFunction("initialize") { () -> Bool in
            do {
                if self.audioEngine != nil {
                    return true
                }
                self.audioEngine = try AudioEngine()
                self.setupMicrophoneCallback()
                self.setupInputAudioLevelCallback()
                self.setupAudioInterruptionCallback()
                return true
            } catch {
                print("Failed to initialize AudioEngine: \(error)")
                return false
            }
        }

        Function("isRecording") { () -> Bool in
            guard let audioEngine = self.audioEngine else {
                print("AudioEngine not initialized")
                return false
            }
            return audioEngine.isRecording
        }

        Function("toggleRecording") { (val: Bool) -> Bool in
            guard let audioEngine = self.audioEngine else {
                print("AudioEngine not initialized")
                return false
            }
            let isRecording = audioEngine.toggleRecording(val)
            self.sendEvent(
                ON_RECORDING_CHANGE_EVENT_NAME,
                [
                    "data": isRecording
                ])
            return isRecording
        }

        Function("getMicrophoneModeIOS") { () -> String in
            if #available(iOS 15.0, *) {
                let mode = AVCaptureDevice.preferredMicrophoneMode.rawValue
                var micMode = ""

                switch mode {
                case 1:
                    micMode = MicrophoneMode.wideSpectrum.rawValue
                case 2:
                    micMode = MicrophoneMode.voiceIsolation.rawValue
                default:
                    micMode = MicrophoneMode.standard.rawValue
                }
                return micMode
            }
            print("Please update your ios")

            return ""
        }

        Function("setMicrophoneModeIOS") {
            if #available(iOS 15, *) {
                if AVCaptureDevice.preferredMicrophoneMode != .voiceIsolation {
                    AVCaptureDevice.showSystemUserInterface(.microphoneModes)
                }
            } else {
                print("This code only runs on iOS 14 and lower")
            }
        }

        Function("tearDown") {
            self.audioEngine?.tearDown()
            self.audioEngine = nil
        }

        Function("restart") {
            _ = self.audioEngine?.toggleRecording(true)
            self.sendEvent(
                ON_RECORDING_CHANGE_EVENT_NAME,
                [
                    "data": audioEngine?.isRecording
                ])

        }

        Function("bypassVoiceProcessing") { (bypass: Bool) in
            self.audioEngine?.bypassVoiceProcessing(bypass)
        }

        AsyncFunction("getMicrophonePermissionsAsync") { (promise: Promise) in
            EXPermissionsMethodsDelegate.getPermissionWithPermissionsManager(
                self.appContext?.permissions,
                withRequester: MicrophonePermissionRequester.self,
                resolve: promise.resolver,
                reject: promise.legacyRejecter
            )
        }

        AsyncFunction("requestMicrophonePermissionsAsync") { (promise: Promise) in
            EXPermissionsMethodsDelegate.askForPermission(
                withPermissionsManager: self.appContext?.permissions,
                withRequester: MicrophonePermissionRequester.self,
                resolve: promise.resolver,
                reject: promise.legacyRejecter
            )
        }

        AsyncFunction("speechAvailability") { (locale: String) async -> [String: Any] in
            guard #available(iOS 26.0, *) else {
                return ["status": "unsupported", "locale": NSNull()]
            }
            return await OnDeviceSpeechController.availability(locale: locale)
        }

        AsyncFunction("speechDownload") { (locale: String) async -> Bool in
            guard #available(iOS 26.0, *), let speech = self.onDeviceSpeech() else {
                return false
            }
            return await speech.download(locale: locale)
        }

        AsyncFunction("speechStart") { (locale: String, sampleRate: Double) async -> [String: Any] in
            guard #available(iOS 26.0, *), let speech = self.onDeviceSpeech() else {
                return ["started": false, "reason": "unsupported"]
            }
            return await speech.start(locale: locale, sampleRate: sampleRate)
        }

        Function("speechFeed") { (pcm: Data) in
            guard #available(iOS 26.0, *) else { return }
            self.onDeviceSpeech()?.feed(pcm)
        }

        AsyncFunction("speechFinish") { () async throws -> String in
            guard #available(iOS 26.0, *), let speech = self.onDeviceSpeech() else {
                throw Exception(name: "OnDeviceSpeechException", description: "On-device speech needs iOS 26")
            }
            return try await speech.finish()
        }

        Function("speechCancel") {
            guard #available(iOS 26.0, *) else { return }
            self.onDeviceSpeech()?.cancel()
        }

        Events([
            ON_MIC_DATA_EVENT_NAME,
            ON_INPUT_VOLUME_LEVEL_EVENT_NAME,
            ON_RECORDING_CHANGE_EVENT_NAME,
            ON_AUDIO_INTERRUPTION_EVENT_NAME,
            ON_SPEECH_TEXT_EVENT_NAME,
            ON_SPEECH_ERROR_EVENT_NAME,
            ON_SPEECH_DOWNLOAD_PROGRESS_EVENT_NAME,
        ])
    }

    @available(iOS 26.0, *)
    private func onDeviceSpeech() -> OnDeviceSpeechController? {
        speech as? OnDeviceSpeechController
    }

    private func setupMicrophoneCallback() {
        audioEngine?.onMicDataCallback = { [weak self] data in
            self?.sendEvent(
                ON_MIC_DATA_EVENT_NAME,
                [
                    "data": data
                ])
        }
    }

    private func setupInputAudioLevelCallback() {
        audioEngine?.onInputVolumeCallback = { [weak self] level in
            self?.sendEvent(
                ON_INPUT_VOLUME_LEVEL_EVENT_NAME,
                [
                    "data": level
                ])
        }
    }

    private func setupAudioInterruptionCallback() {
        audioEngine?.onAudioInterruptionCallback = { [weak self] data in
            self?.sendEvent(
                ON_AUDIO_INTERRUPTION_EVENT_NAME,
                [
                    "data": data
                ])
            self?.sendEvent(
                ON_RECORDING_CHANGE_EVENT_NAME,
                [
                    "data": self?.audioEngine?.isRecording
                ])
        }
    }

    enum MicrophoneMode: String, Enumerable {
        case standard
        case voiceIsolation
        case wideSpectrum
    }
}
