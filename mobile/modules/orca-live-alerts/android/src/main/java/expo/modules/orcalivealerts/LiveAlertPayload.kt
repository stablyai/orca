package expo.modules.orcalivealerts

import org.json.JSONException
import org.json.JSONObject

/**
 * One rendering of the live notification. TypeScript computes every string and number
 * (mobile/src/live-alerts/live-alert-payload.ts); this side only reads the JSON.
 */
internal data class LiveAlertPayload(
  val phase: String,
  val title: String,
  val text: String,
  val subText: String?,
  val chipText: String?,
  val startedAt: Long,
  val progressFinished: Int?,
  val progressTotal: Int?,
  val indeterminate: Boolean,
  val targetJson: String?
) {
  /** Working, waiting and lingering notifications are ongoing; the final one is dismissable. */
  val isOngoing: Boolean
    get() = phase != PHASE_FINAL

  val isLingering: Boolean
    get() = phase == PHASE_LINGERING

  companion object {
    const val PHASE_WORKING = "working"
    const val PHASE_WAITING = "waiting"
    const val PHASE_LINGERING = "lingering"
    const val PHASE_FINAL = "final"
    private val PHASES = setOf(PHASE_WORKING, PHASE_WAITING, PHASE_LINGERING, PHASE_FINAL)

    /** Null for anything that is not a payload, so a bad call never posts a broken notification. */
    fun parse(json: String?): LiveAlertPayload? {
      if (json.isNullOrBlank()) {
        return null
      }
      return try {
        val obj = JSONObject(json)
        val phase = obj.optString("phase")
        val title = obj.optString("title")
        if (phase !in PHASES || title.isBlank()) {
          null
        } else {
          LiveAlertPayload(
            phase = phase,
            title = title,
            text = obj.optString("text"),
            subText = obj.optionalString("subText"),
            chipText = obj.optionalString("chipText"),
            startedAt = obj.optLong("startedAt", System.currentTimeMillis()),
            progressFinished = obj.optionalInt("progressFinished"),
            progressTotal = obj.optionalInt("progressTotal"),
            indeterminate = obj.optBoolean("indeterminate", false),
            targetJson = obj.optionalString("targetJson")
          )
        }
      } catch (e: JSONException) {
        null
      }
    }

    /**
     * Posted when a service start finds the session already finished: a service started with
     * startForegroundService must call startForeground once before it may stop.
     */
    fun placeholder(): LiveAlertPayload =
      LiveAlertPayload(
        phase = PHASE_WORKING,
        title = "Agent working",
        text = "",
        subText = null,
        chipText = null,
        startedAt = System.currentTimeMillis(),
        progressFinished = null,
        progressTotal = null,
        indeterminate = false,
        targetJson = null
      )
  }
}

// JSONObject.optString answers "null" for a JSON null; these read null and empty as absent.
private fun JSONObject.optionalString(name: String): String? =
  if (isNull(name)) null else optString(name).takeIf { it.isNotEmpty() }

private fun JSONObject.optionalInt(name: String): Int? = if (isNull(name)) null else optInt(name)
