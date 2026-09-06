package expo.modules.mobilewebshell

import org.json.JSONObject
import org.json.JSONTokener

internal data class MobileWebActivationRecord(
  val active: String,
  val previous: String?
)

internal fun parseMobileWebActivationRecord(json: String): MobileWebActivationRecord {
  val value = try {
    require(isExactMobileWebJsonDocument(json))
    val tokens = JSONTokener(json)
    val candidate = tokens.nextValue()
    require(candidate is JSONObject && tokens.nextClean() == '\u0000')
    candidate
  } catch (_: Exception) {
    throw invalidActivation()
  }
  val keys = value.keys().asSequence().toSet()
  require(keys == setOf("active") || keys == setOf("active", "previous")) {
    "mobile_web_activation_invalid"
  }
  val active = value.opt("active") as? String ?: throw invalidActivation()
  val previous = if ("previous" in keys) {
    value.opt("previous") as? String ?: throw invalidActivation()
  } else {
    null
  }
  require(
    isMobileWebSha256(active) &&
      (previous == null || isMobileWebSha256(previous) && previous != active)
  ) {
    "mobile_web_activation_invalid"
  }
  return MobileWebActivationRecord(active, previous)
}

private fun invalidActivation(): IllegalArgumentException =
  IllegalArgumentException("mobile_web_activation_invalid")
