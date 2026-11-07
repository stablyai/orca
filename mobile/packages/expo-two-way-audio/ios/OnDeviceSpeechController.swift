import AVFoundation
import ExpoModulesCore
import Foundation
import Speech

let ON_SPEECH_TEXT_EVENT_NAME = "onSpeechText"
let ON_SPEECH_ERROR_EVENT_NAME = "onSpeechError"
let ON_SPEECH_DOWNLOAD_PROGRESS_EVENT_NAME = "onSpeechDownloadProgress"

// Implements the on-device speech contract in src/speech.ts: one live session, fed PCM from JavaScript.
@available(iOS 26.0, *)
final class OnDeviceSpeechController: @unchecked Sendable {
    private let lock = NSLock()
    private var current: OnDeviceSpeechSession?
    // The session speechFinish is draining; speechCancel and a newer speechStart still stop it.
    private var finishing: OnDeviceSpeechSession?
    // Bumped whenever the live session changes so a stale session's events and start result are dropped.
    private var generation = 0
    private let emit: @Sendable (String, [String: Any]) -> Void

    init(emit: @escaping @Sendable (String, [String: Any]) -> Void) {
        self.emit = emit
    }

    static func availability(locale identifier: String) async -> [String: Any] {
        guard let locale = await OnDeviceTranscriber.supportedLocale(for: identifier) else {
            return ["status": "unsupported", "locale": NSNull()]
        }
        switch await OnDeviceSpeechAssets.readiness(for: locale) {
        case .ready:
            return ["status": "ready", "locale": locale.identifier(.bcp47)]
        case .needsDownload:
            return ["status": "needs-download", "locale": locale.identifier(.bcp47)]
        case .unsupported:
            return ["status": "unsupported", "locale": NSNull()]
        }
    }

    func download(locale identifier: String) async -> Bool {
        guard let locale = await OnDeviceTranscriber.supportedLocale(for: identifier) else {
            return false
        }
        let resolved = locale.identifier(.bcp47)
        do {
            try await OnDeviceSpeechAssets.install(locale) { [emit] fraction in
                emit(ON_SPEECH_DOWNLOAD_PROGRESS_EVENT_NAME, ["locale": resolved, "fraction": fraction])
            }
            return await OnDeviceSpeechAssets.readiness(for: locale) == .ready
        } catch {
            print("Could not install on-device speech assets for \(resolved): \(error)")
            return false
        }
    }

    func start(locale identifier: String, sampleRate: Double) async -> [String: Any] {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true) else {
            return ["started": false, "reason": "failed"]
        }
        let (session, mine, stale) = lock.withLock { () -> (OnDeviceSpeechSession, Int, [OnDeviceSpeechSession]) in
            let stale = detachAll()
            let mine = generation
            let session = OnDeviceSpeechSession(
                locale: identifier,
                inputFormat: format,
                onText: { [weak self] revision, committed, tentative in
                    self?.emitIfCurrent(
                        mine, ON_SPEECH_TEXT_EVENT_NAME,
                        ["revision": revision, "committed": committed, "tentative": tentative])
                },
                onFailure: { [weak self] error in
                    self?.fail(mine, error)
                })
            current = session
            return (session, mine, stale)
        }
        stale.forEach { $0.cancel() }

        do {
            let locale = try await session.ready.value
            guard isCurrent(mine) else {
                return ["started": false, "reason": "busy"]
            }
            return ["started": true, "locale": locale.identifier(.bcp47)]
        } catch {
            if take(mine) != nil {
                session.cancel()
            }
            return ["started": false, "reason": Self.reason(for: error)]
        }
    }

    func feed(_ pcm: Data) {
        lock.withLock { current }?.append(pcm: pcm)
    }

    func finish() async throws -> String {
        let session = lock.withLock { () -> OnDeviceSpeechSession? in
            let session = current
            current = nil
            finishing = session
            generation += 1
            return session
        }
        guard let session else {
            throw Self.speechException("No on-device speech session is running")
        }
        defer {
            lock.withLock {
                if finishing === session {
                    finishing = nil
                }
            }
        }
        do {
            return try await session.finish()
        } catch {
            throw Self.speechException("On-device speech recognition failed: \(error)")
        }
    }

    func cancel() {
        let stale = lock.withLock { detachAll() }
        stale.forEach { $0.cancel() }
    }

    private func fail(_ generation: Int, _ error: Error) {
        guard let session = take(generation) else { return }
        session.cancel()
        print("On-device speech session failed: \(error)")
        emit(ON_SPEECH_ERROR_EVENT_NAME, ["code": Self.reason(for: error)])
    }

    // Emits under the lock (sendEvent only schedules) so a cancel or start can't slip in after the check.
    private func emitIfCurrent(_ generation: Int, _ name: String, _ body: [String: Any]) {
        lock.withLock {
            if self.generation == generation {
                emit(name, body)
            }
        }
    }

    private func isCurrent(_ generation: Int) -> Bool {
        lock.withLock { self.generation == generation }
    }

    // Detaches the live session if it is still the one from `generation`.
    private func take(_ generation: Int) -> OnDeviceSpeechSession? {
        lock.withLock {
            guard let session = current, generation == self.generation else {
                return nil
            }
            current = nil
            self.generation += 1
            return session
        }
    }


    // Call inside `lock.withLock`; the caller cancels the returned sessions after unlocking.
    private func detachAll() -> [OnDeviceSpeechSession] {
        let stale = [current, finishing].compactMap { $0 }
        current = nil
        finishing = nil
        generation += 1
        return stale
    }

    private static func speechException(_ description: String) -> Exception {
        Exception(name: "OnDeviceSpeechException", description: description)
    }

    private static func reason(for error: Error) -> String {
        switch error as? OnDeviceSpeechError {
        case .unsupported:
            return "unsupported"
        case .needsDownload:
            return "needs-download"
        case .audioFormat, .none:
            return "failed"
        }
    }
}
