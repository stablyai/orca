import AVFoundation
import Foundation
import Speech

// Orca's bridge to Apple's on-device SpeechAnalyzer (macOS 26+).
//
//   status    --locale <bcp47>            one JSON object describing asset state
//   install   --locale <bcp47>            NDJSON install progress
//   transcribe --locale <bcp47> [--sample-rate N]
//                                         float32 mono PCM on stdin, NDJSON results on stdout
//
// Every command writes newline-delimited JSON so the host can consume events as
// they happen; a non-zero exit always follows an `error` line.

let stdoutQueue = DispatchQueue(label: "dev.orca.speech-transcriber.stdout")

func emit(_ payload: [String: Any]) {
  guard
    let data = try? JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes])
  else {
    return
  }
  stdoutQueue.sync {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
}

func emitError(_ code: String, _ message: String? = nil) {
  var payload: [String: Any] = ["type": "error", "error": code]
  if let message {
    payload["detail"] = message
  }
  emit(payload)
}

func fail(_ code: String, _ message: String? = nil) -> Never {
  emitError(code, message)
  exit(1)
}

func flagValue(_ name: String) -> String? {
  let arguments = CommandLine.arguments
  guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
    return nil
  }
  return arguments[index + 1]
}

/// Orca stores languages as `en`, `pt-BR`, or `multilingual`; Speech wants a Locale.
func requestedLocale() -> Locale {
  guard let raw = flagValue("--locale"), !raw.isEmpty, raw != "multilingual" else {
    return Locale.current
  }
  return Locale(identifier: raw.replacingOccurrences(of: "_", with: "-"))
}

@available(macOS 26.0, *)
func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
  SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [.volatileResults],
    attributeOptions: []
  )
}

@available(macOS 26.0, *)
func assetStatusName(_ status: AssetInventory.Status) -> String {
  switch status {
  case .installed: return "installed"
  case .downloading: return "downloading"
  case .supported: return "supported"
  case .unsupported: return "unsupported"
  @unknown default: return "unsupported"
  }
}

@available(macOS 26.0, *)
func resolveSupportedLocale(_ locale: Locale) async -> Locale? {
  await SpeechTranscriber.supportedLocale(equivalentTo: locale)
}

@available(macOS 26.0, *)
func runStatus() async {
  let requested = requestedLocale()
  guard SpeechTranscriber.isAvailable else {
    emit(["type": "status", "status": "unsupported", "reason": "transcriber_unavailable"])
    return
  }
  guard let locale = await resolveSupportedLocale(requested) else {
    emit([
      "type": "status",
      "status": "unsupported",
      "reason": "locale_unsupported",
      "requestedLocale": requested.identifier
    ])
    return
  }
  let status = await AssetInventory.status(forModules: [makeTranscriber(locale)])
  emit([
    "type": "status",
    "status": assetStatusName(status),
    "locale": locale.identifier(.bcp47),
    "requestedLocale": requested.identifier
  ])
}

@available(macOS 26.0, *)
func runInstall() async {
  let requested = requestedLocale()
  guard SpeechTranscriber.isAvailable else {
    fail("transcriber_unavailable")
  }
  guard let locale = await resolveSupportedLocale(requested) else {
    fail("locale_unsupported", requested.identifier)
  }
  let transcriber = makeTranscriber(locale)
  do {
    // Why reserve: the system caps how many locales one app keeps installed, and
    // an unreserved locale can be reclaimed out from under the next dictation.
    _ = try await AssetInventory.reserve(locale: locale)
    guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber])
    else {
      emit(["type": "installed", "locale": locale.identifier(.bcp47)])
      return
    }
    let progress = request.progress
    let observer = progress.observe(\.fractionCompleted, options: [.initial, .new]) { reported, _ in
      emit(["type": "progress", "progress": reported.fractionCompleted])
    }
    defer { observer.invalidate() }
    try await request.downloadAndInstall()
    emit(["type": "installed", "locale": locale.identifier(.bcp47)])
  } catch {
    fail("install_failed", error.localizedDescription)
  }
}

/// Feeds stdin PCM into the analyzer, resampling to whatever format it asked for.
@available(macOS 26.0, *)
final class PcmStdinPump: @unchecked Sendable {
  private let inputFormat: AVAudioFormat
  private let analyzerFormat: AVAudioFormat
  private let converter: AVAudioConverter
  private let continuation: AsyncStream<AnalyzerInput>.Continuation
  private var residual = Data()

  init?(
    sampleRate: Double,
    analyzerFormat: AVAudioFormat,
    continuation: AsyncStream<AnalyzerInput>.Continuation
  ) {
    guard
      let inputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: false
      ),
      let converter = AVAudioConverter(from: inputFormat, to: analyzerFormat)
    else {
      return nil
    }
    self.inputFormat = inputFormat
    self.analyzerFormat = analyzerFormat
    self.converter = converter
    self.continuation = continuation
  }

  /// Blocks the calling thread until stdin closes.
  func pumpUntilEndOfInput() {
    let handle = FileHandle.standardInput
    while true {
      let chunk = handle.availableData
      if chunk.isEmpty {
        break
      }
      residual.append(chunk)
      let frameBytes = 4
      let usableBytes = (residual.count / frameBytes) * frameBytes
      if usableBytes == 0 {
        continue
      }
      let samples = residual.prefix(usableBytes)
      residual.removeFirst(usableBytes)
      if let input = makeInput(from: samples) {
        continuation.yield(input)
      }
    }
    continuation.finish()
  }

  private func makeInput(from bytes: Data) -> AnalyzerInput? {
    let frameCount = AVAudioFrameCount(bytes.count / 4)
    guard
      frameCount > 0,
      let source = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frameCount),
      let channel = source.floatChannelData?[0]
    else {
      return nil
    }
    source.frameLength = frameCount
    bytes.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      channel.update(from: base.assumingMemoryBound(to: Float.self), count: Int(frameCount))
    }
    guard let converted = convert(source) else {
      return nil
    }
    return AnalyzerInput(buffer: converted)
  }

  private func convert(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if inputFormat == analyzerFormat {
      return source
    }
    let ratio = analyzerFormat.sampleRate / inputFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(source.frameLength) * ratio) + 1024
    guard let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else {
      return nil
    }
    var consumed = false
    var conversionError: NSError?
    let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
      if consumed {
        outStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      outStatus.pointee = .haveData
      return source
    }
    if status == .error || output.frameLength == 0 {
      if let conversionError {
        // Why stderr, not an error event: one unusable slice must not end a
        // dictation the way a reported error would.
        FileHandle.standardError.write(
          Data("orca-speech-transcriber: audio conversion failed: \(conversionError)\n".utf8)
        )
      }
      return nil
    }
    return output
  }
}

@available(macOS 26.0, *)
func runTranscribe() async {
  let requested = requestedLocale()
  let sampleRate = Double(flagValue("--sample-rate") ?? "") ?? 16000
  guard SpeechTranscriber.isAvailable else {
    fail("transcriber_unavailable")
  }
  guard let locale = await resolveSupportedLocale(requested) else {
    fail("locale_unsupported", requested.identifier)
  }
  let transcriber = makeTranscriber(locale)
  let assetStatus = await AssetInventory.status(forModules: [transcriber])
  guard assetStatus == .installed else {
    fail("assets_not_installed", assetStatusName(assetStatus))
  }

  guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
  else {
    fail("no_compatible_audio_format")
  }

  let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
  guard
    let pump = PcmStdinPump(
      sampleRate: sampleRate,
      analyzerFormat: analyzerFormat,
      continuation: continuation
    )
  else {
    fail("audio_converter_unavailable")
  }

  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let results = Task {
    do {
      for try await result in transcriber.results {
        let text = String(result.text.characters)
        // An empty volatile result retracts the live preview, so it is worth
        // sending; an empty final segment carries nothing.
        if result.isFinal {
          if !text.isEmpty {
            emit(["type": "final", "text": text])
          }
        } else {
          emit(["type": "partial", "text": text])
        }
      }
    } catch {
      emitError("transcription_failed", error.localizedDescription)
    }
  }

  do {
    try await analyzer.start(inputSequence: stream)
  } catch {
    results.cancel()
    fail("analyzer_start_failed", error.localizedDescription)
  }
  emit(["type": "ready", "locale": locale.identifier(.bcp47)])

  await withCheckedContinuation { (resume: CheckedContinuation<Void, Never>) in
    // Why a dedicated thread: reading stdin blocks, and the cooperative pool
    // must stay free for the analyzer's own work.
    let thread = Thread {
      pump.pumpUntilEndOfInput()
      resume.resume()
    }
    thread.name = "orca-speech-stdin"
    thread.start()
  }

  do {
    try await analyzer.finalizeAndFinishThroughEndOfInput()
  } catch {
    emitError("finalize_failed", error.localizedDescription)
  }
  await results.value
  emit(["type": "stopped"])
}

@available(macOS 26.0, *)
func runCommand() async {
  switch CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "" {
  case "status":
    await runStatus()
  case "install":
    await runInstall()
  case "transcribe":
    await runTranscribe()
  default:
    fail("unknown_command")
  }
}

if #available(macOS 26.0, *) {
  await runCommand()
} else {
  fail("unsupported_macos")
}
