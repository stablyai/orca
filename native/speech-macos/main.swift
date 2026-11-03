import AVFoundation
import Foundation
import Speech

@main
struct OrcaSpeech {
    static func main() async {
        guard #available(macOS 26.0, *) else {
            fail("macOS Speech requires macOS 26 or newer")
        }
        do {
            try await run()
        } catch {
            fail(error.localizedDescription)
        }
    }

    static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }

    @available(macOS 26.0, *)
    static func run() async throws {
        guard CommandLine.arguments.count == 2 else { fail("Expected a WAV file or --prepare") }
        guard SpeechTranscriber.isAvailable else {
            fail("SpeechTranscriber is unavailable on this Mac. Select another speech model.")
        }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) else {
            fail("macOS Speech does not support the system language. Select another speech model.")
        }
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        if CommandLine.arguments[1] == "--prepare" {
            if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await installation.downloadAndInstall()
            }
            return
        }
        guard await SpeechTranscriber.installedLocales.contains(locale) else {
            fail("macOS Speech language assets are missing. Select macOS Speech again in Voice settings to install them.")
        }
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: CommandLine.arguments[1]))
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        async let transcript = collectResults(transcriber)
        do {
            try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
            print(try await transcript)
        } catch {
            await analyzer.cancelAndFinishNow()
            throw error
        }
    }

    @available(macOS 26.0, *)
    static func collectResults(_ transcriber: SpeechTranscriber) async throws -> String {
        var text = ""
        for try await result in transcriber.results {
            text += String(result.text.characters)
        }
        return text
    }
}
