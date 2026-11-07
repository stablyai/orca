import AVFoundation
import Foundation
import Speech

enum OnDeviceSpeechError: Error {
    case unsupported
    case needsDownload
    case audioFormat
}

// SpeechTranscriber where the hardware runs it; elsewhere (older iPhones, the simulator) the keyboard dictation model.
@available(iOS 26.0, macOS 26.0, *)
enum OnDeviceTranscriber {
    case speech(SpeechTranscriber)
    case dictation(DictationTranscriber)

    init(locale: Locale) {
        if SpeechTranscriber.isAvailable {
            self = .speech(SpeechTranscriber(locale: locale, preset: .progressiveTranscription))
        } else {
            self = .dictation(DictationTranscriber(locale: locale, preset: .progressiveLongDictation))
        }
    }

    // nil when this language can't be transcribed on device.
    static func supportedLocale(for identifier: String) async -> Locale? {
        let locale = Locale(identifier: identifier)
        guard locale.region == nil, let language = locale.language.languageCode else {
            return await equivalent(to: locale)
        }
        // A bare language matches an arbitrary region ("en" gave en-NZ); prefer the phone's languages, then its region.
        let preferred = Locale.preferredLanguages.map { Locale(identifier: $0) }.filter { $0.language.languageCode == language }
        let regions = preferred.compactMap(\.region) + [Locale.current.region].compactMap { $0 }
        for region in regions {
            let regional = Locale(languageCode: language, script: locale.language.script, languageRegion: region)
            if let match = await equivalent(to: regional), match.region == region {
                return match
            }
        }
        return await equivalent(to: locale)
    }

    private static func equivalent(to locale: Locale) async -> Locale? {
        if SpeechTranscriber.isAvailable {
            return await SpeechTranscriber.supportedLocale(equivalentTo: locale)
        }
        return await DictationTranscriber.supportedLocale(equivalentTo: locale)
    }

    var module: any SpeechModule {
        switch self {
        case .speech(let transcriber): transcriber
        case .dictation(let transcriber): transcriber
        }
    }

    // Collects results until the analyzer finishes; resolves with every finalized word.
    func collect(
        onText: @escaping @Sendable (_ revision: Int, _ committed: String, _ tentative: String) -> Void,
        onFailure: @escaping @Sendable (Error) -> Void
    ) -> Task<String, Error> {
        switch self {
        case .speech(let transcriber):
            Self.collect(transcriber.results, text: { $0.text }, onText: onText, onFailure: onFailure)
        case .dictation(let transcriber):
            Self.collect(transcriber.results, text: { $0.text }, onText: onText, onFailure: onFailure)
        }
    }

    private static func collect<Results: AsyncSequence & Sendable>(
        _ results: Results,
        text: @escaping @Sendable (Results.Element) -> AttributedString,
        onText: @escaping @Sendable (Int, String, String) -> Void,
        onFailure: @escaping @Sendable (Error) -> Void
    ) -> Task<String, Error> where Results.Element: SpeechModuleResult {
        Task {
            var committed = ""
            var revision = 0
            do {
                for try await result in results {
                    let words = String(text(result).characters)
                    revision += 1
                    if result.isFinal {
                        committed += words
                        onText(revision, committed, "")
                    } else {
                        onText(revision, committed, words)
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
    }
}

// Language assets for the on-device transcriber.
@available(iOS 26.0, macOS 26.0, *)
enum OnDeviceSpeechAssets {
    static func status(for locale: Locale) async -> AssetInventory.Status {
        await AssetInventory.status(forModules: [OnDeviceTranscriber(locale: locale).module])
    }

    static func install(_ locale: Locale, onProgress: @escaping @Sendable (Double) -> Void) async throws {
        let transcriber = OnDeviceTranscriber(locale: locale).module
        if await AssetInventory.status(forModules: [transcriber]) == .unsupported {
            throw OnDeviceSpeechError.unsupported
        }
        try await reserve(locale)
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

    // The system only downloads, and keeps, assets for locales the app has reserved, up to a per-app limit.
    private static func reserve(_ locale: Locale) async throws {
        let reserved = await AssetInventory.reservedLocales
        if reserved.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
            return
        }
        // At the limit, give up another language's reservation rather than fail this download.
        if reserved.count >= AssetInventory.maximumReservedLocales, let other = reserved.first {
            await AssetInventory.release(reservedLocale: other)
        }
        try await AssetInventory.reserve(locale: locale)
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
            guard let locale = await OnDeviceTranscriber.supportedLocale(for: identifier) else {
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
        let transcriber = OnDeviceTranscriber(locale: locale)
        guard
            let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [transcriber.module], considering: inputFormat),
            let converter = AVAudioConverter(from: inputFormat, to: analyzerFormat)
        else {
            onFailure(OnDeviceSpeechError.audioFormat)
            throw OnDeviceSpeechError.audioFormat
        }
        // Keep every input frame; the default priming drops the start of each converted buffer.
        converter.primeMethod = .none

        let collector = transcriber.collect(onText: onText, onFailure: onFailure)
        let (analyzerStream, analyzerInput) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let analyzer = SpeechAnalyzer(modules: [transcriber.module])
        do {
            do {
                try await analyzer.start(inputSequence: analyzerStream)
            } catch {
                onFailure(error)
                throw error
            }
            for await buffer in stream {
                // A cancelled stream still yields its backlog; don't convert audio nobody will read.
                if Task.isCancelled { break }
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
