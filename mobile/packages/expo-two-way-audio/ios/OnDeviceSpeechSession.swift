import AVFoundation
import Foundation
import Speech

enum OnDeviceSpeechError: Error {
    case unsupported
    case needsDownload
    case audioFormat
}

// Locale resolution and language assets for Apple's on-device transcriber.
@available(iOS 26.0, macOS 26.0, *)
enum OnDeviceSpeechAssets {
    static func transcriber(for locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    }

    // nil when this device or this language can't transcribe on device.
    static func supportedLocale(for identifier: String) async -> Locale? {
        guard SpeechTranscriber.isAvailable else { return nil }
        return await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier))
    }

    static func status(for locale: Locale) async -> AssetInventory.Status {
        await AssetInventory.status(forModules: [transcriber(for: locale)])
    }

    static func install(_ locale: Locale, onProgress: @escaping @Sendable (Double) -> Void) async throws {
        let transcriber = transcriber(for: locale)
        if await AssetInventory.status(forModules: [transcriber]) == .unsupported {
            throw OnDeviceSpeechError.unsupported
        }
        // A nil request means the assets are already installed.
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
            return
        }
        let observation = request.progress.observe(\.fractionCompleted, options: [.initial, .new]) { progress, _ in
            onProgress(progress.fractionCompleted)
        }
        defer { observation.invalidate() }
        try await request.downloadAndInstall()
    }
}

// One dictation: 16-bit PCM in, committed and tentative text out.
@available(iOS 26.0, macOS 26.0, *)
final class OnDeviceSpeechSession: @unchecked Sendable {
    // Resolves to the transcriber's locale once its assets are known to be installed.
    let ready: Task<Locale, Error>
    private let inputFormat: AVAudioFormat
    private let input: AsyncStream<AVAudioPCMBuffer>.Continuation
    private let run: Task<String, Error>

    init(
        locale identifier: String,
        inputFormat: AVAudioFormat,
        onText: @escaping @Sendable (_ revision: Int, _ committed: String, _ tentative: String) -> Void,
        onFailure: @escaping @Sendable (Error) -> Void
    ) {
        self.inputFormat = inputFormat
        // Unbounded so audio fed while the model loads waits here instead of being dropped.
        let (stream, input) = AsyncStream.makeStream(of: AVAudioPCMBuffer.self)
        self.input = input
        let ready = Task { () throws -> Locale in
            guard let locale = await OnDeviceSpeechAssets.supportedLocale(for: identifier) else {
                throw OnDeviceSpeechError.unsupported
            }
            switch await OnDeviceSpeechAssets.status(for: locale) {
            case .installed:
                return locale
            case .unsupported:
                throw OnDeviceSpeechError.unsupported
            default:
                throw OnDeviceSpeechError.needsDownload
            }
        }
        self.ready = ready
        run = Task {
            try await Self.transcribe(
                stream, locale: ready.value, inputFormat: inputFormat, onText: onText, onFailure: onFailure)
        }
    }

    // Copies little-endian 16-bit mono samples; called on the JavaScript thread.
    func append(pcm: Data) {
        let frames = AVAudioFrameCount(pcm.count / MemoryLayout<Int16>.size)
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames),
              let samples = buffer.int16ChannelData?[0]
        else {
            return
        }
        buffer.frameLength = frames
        pcm.withUnsafeBytes { raw in
            _ = raw.copyBytes(to: UnsafeMutableRawBufferPointer(start: samples, count: Int(frames) * MemoryLayout<Int16>.size))
        }
        input.yield(buffer)
    }

    func finish() async throws -> String {
        input.finish()
        return try await run.value
    }

    func cancel() {
        input.finish()
        run.cancel()
    }

    private static func transcribe(
        _ stream: AsyncStream<AVAudioPCMBuffer>,
        locale: Locale,
        inputFormat: AVAudioFormat,
        onText: @escaping @Sendable (Int, String, String) -> Void,
        onFailure: @escaping @Sendable (Error) -> Void
    ) async throws -> String {
        try Task.checkCancellation()
        let transcriber = OnDeviceSpeechAssets.transcriber(for: locale)
        guard
            let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [transcriber], considering: inputFormat),
            let converter = AVAudioConverter(from: inputFormat, to: analyzerFormat)
        else {
            onFailure(OnDeviceSpeechError.audioFormat)
            throw OnDeviceSpeechError.audioFormat
        }
        // Keep every input frame; the default priming drops the start of each converted buffer.
        converter.primeMethod = .none

        let collector = Task { () throws -> String in
            var committed = ""
            var revision = 0
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    revision += 1
                    if result.isFinal {
                        committed += text
                        onText(revision, committed, "")
                    } else {
                        onText(revision, committed, text)
                    }
                }
            } catch {
                if !Task.isCancelled {
                    onFailure(error)
                }
                throw error
            }
            return committed
        }
        let (analyzerStream, analyzerInput) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        do {
            do {
                try await analyzer.start(inputSequence: analyzerStream)
            } catch {
                onFailure(error)
                throw error
            }
            for await buffer in stream {
                if let converted = convert(buffer, with: converter) {
                    analyzerInput.yield(AnalyzerInput(buffer: converted))
                }
            }
            try Task.checkCancellation()
            analyzerInput.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            // Results arrive asynchronously; returning before the collector drains loses the last words.
            return try await collector.value
        } catch {
            analyzerInput.finish()
            await analyzer.cancelAndFinishNow()
            collector.cancel()
            _ = try? await collector.value
            throw error
        }
    }

    private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter) -> AVAudioPCMBuffer? {
        let ratio = converter.outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard capacity > 0, let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else {
            return nil
        }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, output.frameLength > 0 else {
            return nil
        }
        return output
    }
}
