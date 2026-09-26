package expo.modules.orcamobilewebshell

import java.net.URI
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

internal data class BrowserGuestRoute(val profile: String, val proxy: String) {
  companion object {
    fun parse(raw: String): BrowserGuestRoute {
      require(raw.length <= 8192) { "route_too_large" }
      val json = JSONObject(raw)
      val identity = JSONArray()
      for (key in listOf("authorityId", "executionHostId", "orcaProfileId", "browserProfileId")) {
        val value = json.getString(key)
        require(value.isNotBlank() && value.length <= 256) { "invalid_$key" }
        identity.put(value)
      }
      val proxy = URI(json.getString("proxyUrl"))
      require(proxy.scheme in listOf("http", "socks") && proxy.host == "127.0.0.1" && proxy.port in 1..65535 &&
        proxy.rawUserInfo == null && proxy.rawQuery == null && proxy.rawFragment == null &&
        (proxy.rawPath.isNullOrEmpty() || proxy.rawPath == "/")) { "fixture_loopback_proxy_required" }
      val digest = MessageDigest.getInstance("SHA-256").digest(identity.toString().toByteArray())
      return BrowserGuestRoute("orca_browser_" + digest.joinToString("") { "%02x".format(it) }, "${proxy.scheme}://127.0.0.1:${proxy.port}")
    }

    fun navigationUrl(value: String): String {
      require(value.length <= 4096) { "url_too_large" }
      val uri = URI(value)
      require(uri.scheme in listOf("http", "https") && uri.host != null && uri.rawUserInfo == null) { "unsupported_url" }
      return value
    }
  }
}
