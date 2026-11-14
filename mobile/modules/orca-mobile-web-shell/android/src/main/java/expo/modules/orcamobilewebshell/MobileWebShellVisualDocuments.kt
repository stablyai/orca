package expo.modules.orcamobilewebshell

import java.util.UUID

internal const val MOBILE_WEB_SHELL_VISUAL_PREFIX = "/_orca_visual/"
internal const val MOBILE_WEB_SHELL_VISUAL_CSP = "default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; connect-src 'none'; " +
  "frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; " +
  "form-action 'none'; base-uri 'none'; sandbox allow-scripts"

/** Per-document memory only: no caller paths, persistent files or resources surviving a session change. */
internal class MobileWebShellVisualDocuments {
  private val entries = mutableMapOf<String, ByteArray>()
  private var totalBytes = 0

  @Synchronized fun create(html: String): String {
    val bytes = html.toByteArray(Charsets.UTF_8)
    require(bytes.size <= 1024 * 1024 && entries.size < 32 && totalBytes + bytes.size <= 16 * 1024 * 1024)
    val path = "$MOBILE_WEB_SHELL_VISUAL_PREFIX${UUID.randomUUID()}.html"
    entries[path] = bytes
    totalBytes += bytes.size
    return path
  }

  @Synchronized fun read(path: String): ByteArray? = entries[path]

  @Synchronized fun remove(path: String) {
    val removed = entries.remove(path) ?: return
    totalBytes -= removed.size
  }

  @Synchronized fun clear() {
    entries.clear()
    totalBytes = 0
  }
}
