package expo.modules.orcamobilewebshell

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class BrowserGuestRouteTest {
  private fun route() = JSONObject().put("authorityId", "host-a").put("executionHostId", "ssh:box")
    .put("orcaProfileId", "work").put("browserProfileId", "persistent").put("proxyUrl", "http://127.0.0.1:1234")

  @Test fun identityIncludesEveryAuthorityDimensionButNotProxyPort() {
    val base = route()
    val profile = BrowserGuestRoute.parse(base.toString()).profile
    for (key in listOf("authorityId", "executionHostId", "orcaProfileId", "browserProfileId")) {
      assertNotEquals(profile, BrowserGuestRoute.parse(route().put(key, "other").toString()).profile)
    }
    assertEquals(profile, BrowserGuestRoute.parse(route().put("proxyUrl", "http://127.0.0.1:9999").toString()).profile)
  }

  @Test fun onlyExplicitLoopbackProxyIsAdmitted() {
    for (url in listOf("http://localhost:1234", "http://10.0.2.2:1234", "https://127.0.0.1:1234", "http://127.0.0.1", "http://u@127.0.0.1:1", "http://127.0.0.1:1/path")) {
      assertThrows(IllegalArgumentException::class.java) { BrowserGuestRoute.parse(route().put("proxyUrl", url).toString()) }
    }
  }

  @Test fun navigationCannotSelectNativeResources() {
    for (url in listOf("file:///etc/passwd", "content://app/private", "javascript:alert(1)", "http://u@host/")) {
      assertThrows(IllegalArgumentException::class.java) { BrowserGuestRoute.navigationUrl(url) }
    }
    assertEquals("http://fixture.invalid/", BrowserGuestRoute.navigationUrl("http://fixture.invalid/"))
  }
}
