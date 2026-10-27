package expo.modules.orcamobilewebshell

/** Never return null: Chromium’s fallback loader could escape the origin. Empty refusals render no content. */
internal const val MOBILE_WEB_SHELL_REFUSAL_STATUS = 403
internal const val MOBILE_WEB_SHELL_REFUSAL_REASON = "Forbidden"
internal const val MOBILE_WEB_SHELL_REFUSAL_MIME_TYPE = "text/plain"
internal const val MOBILE_WEB_SHELL_REFUSAL_CHARSET = "utf-8"

internal val MOBILE_WEB_SHELL_REFUSAL_HEADERS = mapOf("Cache-Control" to "no-store")

internal fun mobileWebShellRefusalBody(): ByteArray = ByteArray(0)
