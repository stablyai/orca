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

    // nil when this language can't be transcribed on device. Picks deterministically: supportedLocale(equivalentTo:)
    // answers a different region on each call for "en" or an unsupported region such as "en-GH".
    static func supportedLocale(for identifier: String) async -> Locale? {
        let requested = Locale(identifier: identifier)
        let language = maximal(requested)
        let supported = SpeechTranscriber.isAvailable
            ? await SpeechTranscriber.supportedLocales
            : await DictationTranscriber.supportedLocales
        let sameLanguage = supported.filter { sameLanguageAndScript(maximal($0), language) }
            .sorted { $0.identifier(.bcp47) < $1.identifier(.bcp47) }
        // The requested region, then the regions of the phone's own languages and its region, then the language's usual one.
        let phoneRegions = Locale.preferredLanguages.map(Locale.init(identifier:))
            .filter { sameLanguageAndScript(maximal($0), language) }
            .map(\.region)
        let regions = [requested.region] + phoneRegions + [Locale.current.region, language.region]
        for region in regions.compactMap({ $0 }) {
            if let match = sameLanguage.first(where: { $0.region == region }) {
                return match
            }
        }
        return sameLanguage.first
    }

    // Fills in the likely script and region, so "zh-TW" compares as Hant and "en" carries US.
    private static func maximal(_ locale: Locale) -> Locale.Language {
        Locale.Language(identifier: locale.language.maximalIdentifier)
    }

    private static func sameLanguageAndScript(_ a: Locale.Language, _ b: Locale.Language) -> Bool {
        a.languageCode == b.languageCode && a.script == b.script
    }

    var module: any SpeechModule {
        switch self {
        case .speech(let transcriber): transcriber
        case .dictation(let transcriber): transcriber
        }
    }

    // Collects results until the analyzer finishes; resolves with every finalized word.
    func collect(
        onText: @escaping @Sendable (_ committed: String, _ tentative: String) -> Void,
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
        onText: @escaping @Sendable (String, String) -> Void,
        onFailure: @escaping @Sendable (Error) -> Void
    ) -> Task<String, Error> where Results.Element: SpeechModuleResult {
        Task {
            var committed = ""
            do {
                for try await result in results {
                    let words = String(text(result).characters)
                    if result.isFinal {
                        committed += words
                        onText(committed, "")
                    } else {
                        onText(committed, words)
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
    enum Readiness {
        case ready
        case needsDownload
        case unsupported
    }

    static func readiness(for locale: Locale) async -> Readiness {
        let module = OnDeviceTranscriber(locale: locale).module
        switch await AssetInventory.status(forModules: [module]) {
        case .installed:
            // The simulator installs the assets but has no audio format it can run them with ("Model not available").
            return await module.availableCompatibleAudioFormats.isEmpty ? .unsupported : .ready
        case .supported, .downloading:
            return .needsDownload
        default:
            return .unsupported
        }
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
        // At the limit, give up another reservation rather than fail this download, a variant of this language first.
        if reserved.count >= AssetInventory.maximumReservedLocales,
           let other = reserved.first(where: { $0.language.languageCode == locale.language.languageCode }) ?? reserved.first {
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
        onText: @escaping @Sendable (_ committed: String, _ tentative: String) -> Void,
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
            switch await OnDeviceSpeechAssets.readiness(for: locale) {
            case .ready:
                return locale
            case .needsDownload:
                throw OnDeviceSpeechError.needsDownload
            case .unsupported:
                throw OnDeviceSpeechError.unsupported
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
        _ = pcm.copyBytes(to: UnsafeMutableBufferPointer(start: samples, count: Int(frames)))
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
        onText: @escaping @Sendable (String, String) -> Void,
        onFailure: @escaping @Sendable (Error) -> Void
    ) async throws -> String {
        try Task.checkCancellation()
        let transcriber = OnDeviceTranscriber(locale: locale)
        guard
            let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [transcriber.module], considering: inputFormat)
        else {
            onFailure(OnDeviceSpeechError.audioFormat)
            throw OnDeviceSpeechError.audioFormat
        }
        // Convert only when the analyzer wants something other than the fed format.
        var converter: AVAudioConverter?
        if analyzerFormat != inputFormat {
            guard let resampler = AVAudioConverter(from: inputFormat, to: analyzerFormat) else {
                onFailure(OnDeviceSpeechError.audioFormat)
                throw OnDeviceSpeechError.audioFormat
            }
            // Keep every input frame; the default priming drops the start of each converted buffer.
            resampler.primeMethod = .none
            converter = resampler
        }

        let collector = transcriber.collect(onText: onText, onFailure: onFailure)
        let (analyzerStream, analyzerInput) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let analyzer = SpeechAnalyzer(modules: [transcriber.module])
        do {
            try await analyzer.start(inputSequence: analyzerStream)
            for await buffer in stream {
                // A cancelled stream still yields its backlog; don't convert audio nobody will read.
                if Task.isCancelled { break }
                let ready = if let converter { convert(buffer, with: converter) } else { Optional(buffer) }
                if let ready {
                    analyzerInput.yield(AnalyzerInput(buffer: ready))
                }
            }
            try Task.checkCancellation()
            analyzerInput.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            // Results arrive asynchronously; returning before the collector drains loses the last words.
            return try await collector.value
        } catch {
            // The controller ignores this once finish or cancel has detached the session.
            if !Task.isCancelled {
                onFailure(error)
            }
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
