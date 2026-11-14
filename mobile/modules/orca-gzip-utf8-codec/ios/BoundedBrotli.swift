import Compression
import Foundation

struct BoundedBrotliError: Error, CustomStringConvertible {
  let description: String
}

/// Inflate one brotli stream into at most outputLimit bytes; callers pass one byte beyond the length they
/// accept and check the result's length and hash. Compression returns nothing for a stream that is invalid,
/// truncated or longer than the buffer, so all three throw here.
func brotliDecompressBounded(_ input: Data, outputLimit: Int) throws -> Data {
  guard outputLimit > 0, !input.isEmpty else {
    throw BoundedBrotliError(description: "nothing to inflate")
  }
  var output = Data(count: outputLimit)
  let produced = input.withUnsafeBytes { (inBytes: UnsafeRawBufferPointer) -> Int in
    output.withUnsafeMutableBytes { (outBytes: UnsafeMutableRawBufferPointer) -> Int in
      compression_decode_buffer(
        outBytes.bindMemory(to: UInt8.self).baseAddress!, outputLimit,
        inBytes.bindMemory(to: UInt8.self).baseAddress!, inBytes.count,
        nil, COMPRESSION_BROTLI)
    }
  }
  guard produced > 0 else {
    throw BoundedBrotliError(description: "not a whole brotli stream within the output limit")
  }
  return produced == outputLimit ? output : output.prefix(produced)
}
