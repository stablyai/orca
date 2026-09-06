package expo.modules.mobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MobileWebActivationMetadataTest {
  @Test
  fun acceptsOnlyExactActivationMetadata() {
    val active = "a".repeat(64)
    val previous = "b".repeat(64)
    assertEquals(
      MobileWebActivationRecord(active, null),
      parseMobileWebActivationRecord("""{"active":"$active"}""")
    )
    assertEquals(
      MobileWebActivationRecord(active, previous),
      parseMobileWebActivationRecord("""{"active":"$active","previous":"$previous"}""")
    )

    val numericHash = "1".repeat(64)
    val invalid = listOf(
      "[]",
      "{}",
      """{"active":null}""",
      """{"active":true}""",
      """{"active":$numericHash}""",
      """{"active":"${active.uppercase()}"}""",
      """{"active":"$active","previous":null}""",
      """{"active":"$active","previous":true}""",
      """{"active":"$active","previous":"$active"}""",
      """{"active":"$active","unexpected":true}""",
      """{"active":"$active","active":"$active"}""",
      """{"active":"$active"} trailing"""
    )
    invalid.forEach { value ->
      val error = assertThrows(IllegalArgumentException::class.java) {
        parseMobileWebActivationRecord(value)
      }
      assertEquals("mobile_web_activation_invalid", error.message)
    }
  }
}
