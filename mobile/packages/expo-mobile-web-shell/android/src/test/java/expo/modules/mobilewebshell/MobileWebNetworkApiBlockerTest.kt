package expo.modules.mobilewebshell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebNetworkApiBlockerTest {
  @Test
  fun `denies every page network entry point WebView native fences cannot see`() {
    val script = MOBILE_WEB_NETWORK_API_BLOCKER

    assertTrue(script.contains("Object.defineProperties(globalThis,{"))
    for (api in listOf("fetch:{", "XMLHttpRequest:{", "WebSocket:{")) {
      assertTrue(api, script.contains(api))
    }
    assertTrue(script.contains("Network access is disabled"))
    assertTrue(script.contains("var restrictedNavigator=new Proxy(nativeNavigator"))
    assertTrue(script.contains("if(property==='serviceWorker') return undefined"))
    assertTrue(script.contains("Object.defineProperty(serviceWorkerPrototype,'register'"))
    assertTrue(script.contains("Object.defineProperty(navigator,'serviceWorker'"))
    assertTrue(script.contains("Object.defineProperty(Navigator.prototype,'serviceWorker'"))
    assertTrue(script.contains("anchor.hasAttribute('download')"))
    assertTrue(script.contains("/^(?:https?|wss?):\$/.test(anchor.protocol)"))
    assertTrue(script.contains("event.preventDefault()"))
  }

  @Test
  fun `pins every denial as non-configurable and non-writable`() {
    val script = MOBILE_WEB_NETWORK_API_BLOCKER

    assertTrue(script.contains("configurable:false"))
    assertFalse(script.contains("configurable:true"))
    assertFalse(script.contains("writable:true"))
    assertFalse(script.contains("\${'\$'}"))
  }

  @Test
  fun `leaves no unbalanced delimiters that would abort document start injection`() {
    val script = MOBILE_WEB_NETWORK_API_BLOCKER

    assertTrue(script.startsWith("(function(){"))
    assertTrue(script.endsWith("})();"))
    assertTrue(script.count { it == '{' } == script.count { it == '}' })
    assertTrue(script.count { it == '(' } == script.count { it == ')' })
  }
}
