package expo.modules.orcalocalruntime

import org.json.JSONObject

data class OrcadReadiness(
  val endpoint: String?,
  val pairingUrl: String?,
  val pairingUnavailableReason: String?,
  /** The desktop web client with its own runtime pairing; null when orcad was built without it. */
  val webClientUrl: String? = null
)

/** Reads orcad's `--json` readiness line (src/main/server/serve-readiness.ts); anything else is a log line. */
object OrcadReadinessParser {
  fun parse(line: String): OrcadReadiness? {
    val trimmed = line.trim()
    if (!trimmed.startsWith("{")) return null
    val json = try {
      JSONObject(trimmed)
    } catch (_: Exception) {
      return null
    }
    if (json.optString("type") != "orca_server_ready") return null
    val pairing = json.optJSONObject("pairing")
    val available = pairing?.optBoolean("available") == true
    return OrcadReadiness(
      endpoint = json.optString("endpoint").takeIf { it.isNotEmpty() && it != "null" },
      pairingUrl = if (available) pairing?.optString("url")?.takeIf { it.isNotEmpty() } else null,
      pairingUnavailableReason = if (available) null else pairing?.optString("reason"),
      webClientUrl = json.optString("webClientUrl").takeIf { it.startsWith("http") }
    )
  }
}
