package expo.modules.mobilewebshell

import org.json.JSONArray

private const val MOBILE_WEB_JSON_DEPTH_LIMIT = 32

internal fun isExactMobileWebJsonDocument(value: String): Boolean =
  MobileWebExactJsonParser(value).parse()

private class MobileWebExactJsonParser(
  private val value: String
) {
  private var index = 0

  fun parse(): Boolean {
    skipWhitespace()
    if (!parseValue(0)) return false
    skipWhitespace()
    return index == value.length
  }

  private fun parseValue(depth: Int): Boolean {
    if (depth > MOBILE_WEB_JSON_DEPTH_LIMIT || index >= value.length) return false
    return when (value[index]) {
      '{' -> parseObject(depth)
      '[' -> parseArray(depth)
      '"' -> parseStringLiteral() != null
      't' -> consume("true")
      'f' -> consume("false")
      'n' -> consume("null")
      else -> parseNumber()
    }
  }

  private fun parseObject(depth: Int): Boolean {
    if (!consume('{')) return false
    skipWhitespace()
    if (consume('}')) return true
    val keys = mutableSetOf<String>()
    while (true) {
      val literal = parseStringLiteral() ?: return false
      val key = decodeString(literal) ?: return false
      if (!keys.add(key)) return false
      skipWhitespace()
      if (!consume(':')) return false
      skipWhitespace()
      if (!parseValue(depth + 1)) return false
      skipWhitespace()
      if (consume('}')) return true
      if (!consume(',')) return false
      skipWhitespace()
    }
  }

  private fun parseArray(depth: Int): Boolean {
    if (!consume('[')) return false
    skipWhitespace()
    if (consume(']')) return true
    while (true) {
      if (!parseValue(depth + 1)) return false
      skipWhitespace()
      if (consume(']')) return true
      if (!consume(',')) return false
      skipWhitespace()
    }
  }

  private fun parseStringLiteral(): String? {
    if (!consume('"')) return null
    val start = index - 1
    while (index < value.length) {
      val character = value[index++]
      if (character == '"') return value.substring(start, index)
      if (character.code < 0x20) return null
      if (character.isHighSurrogate()) {
        if (index >= value.length || !value[index].isLowSurrogate()) return null
        index += 1
        continue
      }
      if (character.isLowSurrogate()) return null
      if (character != '\\') continue
      if (index >= value.length) return null
      val escaped = value[index++]
      if (escaped == 'u') {
        val codeUnit = parseUnicodeCodeUnit() ?: return null
        if (codeUnit in 0xD800..0xDBFF) {
          if (!consume('\\') || !consume('u')) return null
          val lowSurrogate = parseUnicodeCodeUnit() ?: return null
          if (lowSurrogate !in 0xDC00..0xDFFF) return null
        } else if (codeUnit in 0xDC00..0xDFFF) {
          return null
        }
      } else if (escaped !in "\"\\/bfnrt") {
        return null
      }
    }
    return null
  }

  private fun parseUnicodeCodeUnit(): Int? {
    if (index + 4 > value.length) return null
    var codeUnit = 0
    repeat(4) {
      val digit = value[index++].hexValue() ?: return null
      codeUnit = (codeUnit shl 4) or digit
    }
    return codeUnit
  }

  private fun parseNumber(): Boolean {
    val start = index
    consume('-')
    if (index >= value.length) return false
    if (consume('0')) {
      if (index < value.length && value[index].isJsonDigit()) return false
    } else if (!consumeDigits(firstMustBeNonzero = true)) {
      return false
    }
    if (consume('.') && !consumeDigits(firstMustBeNonzero = false)) return false
    if (index < value.length && value[index] in "eE") {
      index += 1
      if (index < value.length && value[index] in "+-") index += 1
      if (!consumeDigits(firstMustBeNonzero = false)) return false
    }
    return index > start
  }

  private fun consumeDigits(firstMustBeNonzero: Boolean): Boolean {
    if (index >= value.length) return false
    val first = value[index]
    val validFirst = if (firstMustBeNonzero) first in '1'..'9' else first.isJsonDigit()
    if (!validFirst) return false
    index += 1
    while (index < value.length && value[index].isJsonDigit()) index += 1
    return true
  }

  private fun consume(expected: String): Boolean {
    if (!value.startsWith(expected, index)) return false
    index += expected.length
    return true
  }

  private fun consume(expected: Char): Boolean {
    if (index >= value.length || value[index] != expected) return false
    index += 1
    return true
  }

  private fun skipWhitespace() {
    while (index < value.length && value[index] in " \t\n\r") index += 1
  }

  private fun decodeString(literal: String): String? = try {
    JSONArray("[$literal]").get(0) as? String
  } catch (_: Exception) {
    null
  }

  private fun Char.hexValue(): Int? = when (this) {
    in '0'..'9' -> code - '0'.code
    in 'A'..'F' -> code - 'A'.code + 10
    in 'a'..'f' -> code - 'a'.code + 10
    else -> null
  }

  private fun Char.isJsonDigit(): Boolean = this in '0'..'9'

  private fun Char.isHighSurrogate(): Boolean = code in 0xD800..0xDBFF

  private fun Char.isLowSurrogate(): Boolean = code in 0xDC00..0xDFFF
}
