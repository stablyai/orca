package expo.modules.mobilewebshell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebExactJsonTest {
  @Test
  fun rejectsDuplicateKeysTrailingTokensAndExcessDepth() {
    val valid = listOf(
      "{}",
      """{"a":1,"b":[true,false,null,{"c":"\u0063"}]}""",
      """{"a":-1.25e+2}""",
      """{"emoji":"\uD83D\uDE00"}""",
      """{"emoji":"😀"}""",
      nestedObject(32)
    )
    valid.forEach { assertTrue(it, isExactMobileWebJsonDocument(it)) }

    val invalid = listOf(
      "",
      """{"a":1} trailing""",
      """{"a":1,"a":1}""",
      """{"a":1,"\u0061":2}""",
      """{"a":{"b":1,"b":2}}""",
      """[{"a":1,"a":2}]""",
      """{"a":01}""",
      """{"a":+1}""",
      """{"a":1٢}""",
      """{"a":1,}""",
      """{"a":"\x"}""",
      """{"a":"\uD800"}""",
      """{"a":"\uDC00"}""",
      """{"a":"\uD800\uD800"}""",
      """{"\uD800":1}""",
      nestedObject(33)
    )
    invalid.forEach { assertFalse(it, isExactMobileWebJsonDocument(it)) }
  }

  private fun nestedObject(depth: Int): String =
    """{"a":""".repeat(depth) + "0" + "}".repeat(depth)
}
