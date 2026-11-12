package expo.modules.orcamobilewebshell

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

private val DIRECTORY = File("/tmp/generation")

private fun asset(path: Any, contentType: Any): JSONObject =
  JSONObject().put("path", path).put("contentType", contentType)

private fun manifest(
  schemaVersion: Any = 1,
  entrypoint: Any = "index.html",
  assets: List<JSONObject> = listOf(
    asset("index.html", "text/html; charset=utf-8"),
    asset("assets/aa.js", "text/javascript; charset=utf-8"),
    asset("assets/bb.png", "image/png")
  )
): String = JSONObject()
  .put("schemaVersion", schemaVersion)
  .put("entrypoint", entrypoint)
  .put("assets", JSONArray(assets))
  .toString()

private fun make(json: String) = MobileWebShellGeneration.make(json, DIRECTORY)

class MobileWebShellGenerationTest {
  @Test
  fun `refuses a manifest whose shape it does not recognise`() {
    assertNull(make("not json"))
    assertNull(make("[]"))
    assertNull(make(manifest(schemaVersion = 2)))
    assertNull(make(manifest(schemaVersion = "1")))
    assertNull(make(manifest(entrypoint = "start.html")))
    assertNull(make(manifest(assets = emptyList())))
    // Without the entrypoint among the assets, "/" would map to a file nobody declared.
    assertNull(make(manifest(assets = listOf(asset("assets/aa.js", "text/javascript")))))
    assertNull(make(manifest(assets = (0..256).map { asset("assets/a$it.js", "text/javascript") })))
    assertNotNull(make(manifest(assets = listOf(asset("index.html", "text/html")) +
      (0..254).map { asset("assets/a$it.js", "text/javascript") })))
  }

  @Test
  fun `refuses a manifest that declares a path or a content type it will not serve`() {
    assertNull(make(manifest(assets = listOf(
      asset("index.html", "text/html"),
      asset("../escape.js", "text/javascript")
    ))))
    assertNull(make(manifest(assets = listOf(
      asset("index.html", "text/html"),
      asset("assets/aa.js", "text/javascript\r\nX-Injected: 1")
    ))))
    assertNull(make(manifest(assets = listOf(
      asset("index.html", "text/html"),
      asset(7, "text/javascript")
    ))))
    assertNull(make(manifest(assets = listOf(
      asset("index.html", "text/html"),
      asset("assets/aa.js", 7)
    ))))
  }

}
