package expo.modules.orcagziputf8codec

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/** Decode only well-formed UTF-8 without a leading BOM; JS TextDecoder owns replacement/BOM behavior. */
fun decodeStrictUtf8(input: ByteArray): String? {
  if (input.size >= 3 &&
    input[0] == 0xef.toByte() &&
    input[1] == 0xbb.toByte() &&
    input[2] == 0xbf.toByte()
  ) {
    return null
  }
  return try {
    StandardCharsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(input))
      .toString()
  } catch (_: CharacterCodingException) {
    null
  }
}
