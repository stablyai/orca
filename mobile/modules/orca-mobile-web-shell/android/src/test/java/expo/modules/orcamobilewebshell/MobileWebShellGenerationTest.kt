package expo.modules.orcamobilewebshell

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
  fun `maps the document, every declared asset and the manifest itself`() {
    val generation = make(manifest())
    assertNotNull(generation)
    val entries = generation!!.entries
    assertEquals(4, entries.size)
    assertEquals(File(DIRECTORY, "index.html"), entries["/"]!!.file)
    assertEquals("text/html; charset=utf-8", entries["/"]!!.contentType)
    // Only "/" reaches the document: a second URL for the same bytes would answer without the CSP
    // header, which rides the document response alone.
    assertNull(entries["/index.html"])
    assertEquals(File(DIRECTORY, "assets/bb.png"), entries["/assets/bb.png"]!!.file)
    assertEquals("image/png", entries["/assets/bb.png"]!!.contentType)
    // The manifest is written last and is not part of the content hash, so it is not in assets[].
    assertEquals("application/json", entries["/manifest.json"]!!.contentType)
    assertNull(entries["/assets/cc.js"])
  }

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

  @Test
  fun `accepts only portable relative asset paths`() {
    assertTrue(MobileWebShellGeneration.isServableAssetPath("index.html"))
    assertTrue(MobileWebShellGeneration.isServableAssetPath("assets/a-b_c.2.js"))
    assertFalse(MobileWebShellGeneration.isServableAssetPath(""))
    assertFalse(MobileWebShellGeneration.isServableAssetPath("/leading"))
    assertFalse(MobileWebShellGeneration.isServableAssetPath("trailing/"))
    assertFalse(MobileWebShellGeneration.isServableAssetPath("a//b"))
    assertFalse(MobileWebShellGeneration.isServableAssetPath("../secret"))
    assertFalse(MobileWebShellGeneration.isServableAssetPath("assets/../../secret"))
    assertFalse(MobileWebShellGeneration.isServableAssetPath("assets/./a.js"))
    assertFalse(MobileWebShellGeneration.isServableAssetPath("back\\slash"))
    assertFalse(MobileWebShellGeneration.isServableAssetPath("has space.js"))
    assertTrue(MobileWebShellGeneration.isServableAssetPath("a".repeat(255)))
    assertFalse(MobileWebShellGeneration.isServableAssetPath("a".repeat(256)))
  }

  @Test
  fun `accepts only a content type that cannot carry a second header`() {
    assertTrue(MobileWebShellGeneration.isServableContentType("image/png"))
    assertTrue(MobileWebShellGeneration.isServableContentType("text/html; charset=utf-8"))
    assertTrue(MobileWebShellGeneration.isServableContentType("application/manifest+json"))
    assertFalse(MobileWebShellGeneration.isServableContentType(""))
    assertFalse(MobileWebShellGeneration.isServableContentType("text/html\r\nX-Injected: 1"))
    assertFalse(MobileWebShellGeneration.isServableContentType("text/html; charset=utf-8; x=1"))
    assertFalse(MobileWebShellGeneration.isServableContentType("TEXT/HTML"))
    // A header value we did not mint character for character is a value we did not check.
    assertFalse(MobileWebShellGeneration.isServableContentType("text/html; charset=UTF-8"))
    assertFalse(MobileWebShellGeneration.isServableContentType("text"))
    assertFalse(MobileWebShellGeneration.isServableContentType("text/html/extra"))
    assertFalse(MobileWebShellGeneration.isServableContentType("/html"))
    assertFalse(MobileWebShellGeneration.isServableContentType("-text/html"))
    assertFalse(MobileWebShellGeneration.isServableContentType("text/html; charset="))
    assertFalse(MobileWebShellGeneration.isServableContentType("a".repeat(130) + "/b"))
  }

  @Test
  fun `splits the content type the way WebResourceResponse wants it`() {
    assertEquals("text/html" to "utf-8", splitMobileWebShellContentType("text/html; charset=utf-8"))
    assertEquals("image/png" to null, splitMobileWebShellContentType("image/png"))
  }

  @Test
  fun `refuses a directory path that is not absolute`() {
    assertNull(MobileWebShellGeneration.load("relative/generation"))
    assertNull(MobileWebShellGeneration.load(""))
  }
}
