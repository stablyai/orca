import Foundation
import zlib

struct BoundedGunzipError: Error, CustomStringConvertible {
  let description: String
}

/// Validate one gzip member (header, CRC32, ISIZE), rejecting trailing bytes/extra members.
/// Stops at outputLimit with the stream unread; callers pass one byte beyond their accepted limit.
func gunzipBounded(_ input: Data, outputLimit: Int) throws -> Data {
  guard outputLimit >= 0 else {
    throw BoundedGunzipError(description: "negative output limit")
  }
  var output = Data(count: outputLimit)
  if outputLimit == 0 {
    return output
  }
  var stream = z_stream()
  // 16 + MAX_WBITS: a gzip wrapper only, never zlib or raw deflate.
  guard inflateInit2_(&stream, 16 + MAX_WBITS, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
  else {
    throw BoundedGunzipError(description: "inflateInit2 failed")
  }
  defer { inflateEnd(&stream) }
  let produced = try input.withUnsafeBytes { (inBytes: UnsafeRawBufferPointer) -> Int in
    try output.withUnsafeMutableBytes { (outBytes: UnsafeMutableRawBufferPointer) -> Int in
      stream.next_in = UnsafeMutablePointer(
        mutating: inBytes.bindMemory(to: Bytef.self).baseAddress)
      stream.avail_in = uInt(inBytes.count)
      stream.next_out = outBytes.bindMemory(to: Bytef.self).baseAddress
      stream.avail_out = uInt(outBytes.count)
      while true {
        let status = inflate(&stream, Z_NO_FLUSH)
        if status == Z_STREAM_END {
          if stream.avail_in != 0 {
            throw BoundedGunzipError(description: "data after the gzip member")
          }
          return outputLimit - Int(stream.avail_out)
        }
        if stream.avail_out == 0 && (status == Z_OK || status == Z_BUF_ERROR) {
          return outputLimit
        }
        if status == Z_BUF_ERROR {
          throw BoundedGunzipError(description: "truncated gzip stream")
        }
        if status != Z_OK {
          let message = stream.msg.map { String(cString: $0) } ?? "inflate failed (\(status))"
          throw BoundedGunzipError(description: message)
        }
      }
    }
  }
  return produced == outputLimit ? output : output.prefix(produced)
}
