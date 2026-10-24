package expo.modules.orcagziputf8codec

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Synchronous on purpose: each call is a few ms per window, and only a sync call reads its
// Uint8Array argument without a thread hop.
class OrcaGzipUtf8CodecModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OrcaGzipUtf8Codec")

    Function("gunzip") { input: ByteArray, outputLimit: Int ->
      gunzipBounded(input, outputLimit)
    }

    Function("decodeUtf8") { input: ByteArray ->
      decodeStrictUtf8(input)
    }
  }
}
