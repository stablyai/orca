package expo.modules.orcamobilewebshell

/**
 * What a request outside the manifest map is answered with. A refusal is a response, never a null:
 * returning null from `shouldInterceptRequest` hands the request to Chromium's own loader, which is
 * the one path out of this origin that the settings cannot close.
 *
 * The body is empty on purpose. There is nothing to say to a page that asked for something it was
 * never given, and a body is one more thing an error page could render.
 */
internal const val MOBILE_WEB_SHELL_REFUSAL_STATUS = 403
internal const val MOBILE_WEB_SHELL_REFUSAL_REASON = "Forbidden"
internal const val MOBILE_WEB_SHELL_REFUSAL_MIME_TYPE = "text/plain"
internal const val MOBILE_WEB_SHELL_REFUSAL_CHARSET = "utf-8"

internal val MOBILE_WEB_SHELL_REFUSAL_HEADERS = mapOf("Cache-Control" to "no-store")

internal fun mobileWebShellRefusalBody(): ByteArray = ByteArray(0)
