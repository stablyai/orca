import ExpoModulesCore

// Synchronous on purpose: each call is a few ms per window, and only a sync call reads its
// Uint8Array argument without a thread hop.
public class OrcaGzipUtf8CodecModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaGzipUtf8Codec")

    Function("gunzip") { (input: Data, outputLimit: Int) throws -> Data in
      try gunzipBounded(input, outputLimit: outputLimit)
    }

    Function("decodeUtf8") { (input: Data) -> String? in
      decodeStrictUtf8(input)
    }
  }
}
