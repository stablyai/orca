package expo.modules.mobilewebshell

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.MessageDigest
import java.util.Base64

class MobileWebPackageStoreGeneratedMutationTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun rejectsGeneratedManifestChunkAndTokenMutations() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = generatedMutationFixture()
    val manifestBytes = fixture.manifest.toByteArray(Charsets.UTF_8)

    repeat(256) { iteration ->
      val bytes = manifestBytes.copyOf()
      bytes[generatedMutationIndex(iteration, bytes.size)] = 0
      val error = assertThrows(IllegalArgumentException::class.java) {
        store.beginStage(
          "generated-host",
          bytes.toString(Charsets.UTF_8),
          fixture.canonical
        )
      }
      assertEquals("mobile_web_stage_manifest_invalid", error.message)
    }

    val stageId = store.beginStage("generated-host", fixture.manifest, fixture.canonical)
    assertTrue(stageId.matches(Regex("^[A-Za-z0-9_-]{43}$")))
    val encoded = Base64.getEncoder().encodeToString(fixture.bytes)
    repeat(256) { iteration ->
      val characters = encoded.toCharArray()
      characters[generatedMutationIndex(iteration, characters.size)] = '!'
      val error = assertThrows(IllegalArgumentException::class.java) {
        store.writeAssetChunk(
          stageId,
          "index.html",
          0,
          characters.concatToString(),
          generatedMutationSha256(fixture.bytes)
        )
      }
      assertEquals("mobile_web_stage_chunk_invalid", error.message)
    }
    for (offset in 1..128) {
      val error = assertThrows(IllegalArgumentException::class.java) {
        store.writeAssetChunk(
          stageId,
          "index.html",
          offset,
          encoded,
          generatedMutationSha256(fixture.bytes)
        )
      }
      assertEquals("mobile_web_stage_offset_invalid", error.message)
    }
    store.abortStage(stageId)

    val path = "assets/${"a".repeat(64)}.js"
    val forbidden = listOf("\\", "?", "#", "%", "\n", "\u0000", "é")
    repeat(256) { iteration ->
      val index = generatedMutationIndex(iteration, path.length + 1)
      val mutated = path.substring(0, index) +
        forbidden[iteration % forbidden.size] +
        path.substring(index)
      assertFalse(isSafeMobileWebAssetPath(mutated))
    }
    val hash = "a".repeat(64)
    repeat(256) { iteration ->
      val characters = hash.toCharArray()
      characters[generatedMutationIndex(iteration, characters.size)] =
        if (iteration % 2 == 0) 'A' else '!'
      assertFalse(isMobileWebSha256(characters.concatToString()))
    }
  }

  private fun generatedMutationFixture(): GeneratedMutationFixture {
    val bytes = "<!doctype html><title>Generated mutation</title>".toByteArray()
    val asset = JSONObject()
      .put("path", "index.html")
      .put("sha256", generatedMutationSha256(bytes))
      .put("byteLength", bytes.size)
      .put("contentType", "text/html; charset=utf-8")
      .put("role", "document")
    val canonical = JSONObject()
      .put("schemaVersion", 1)
      .put("bridge", JSONObject().put("minimum", 1).put("testedThrough", 1))
      .put("entrypoint", "index.html")
      .put("totalBytes", bytes.size)
      .put("assets", JSONArray().put(asset))
      .toString()
    val manifest = JSONObject(canonical)
      .put("buildId", generatedMutationSha256(canonical.toByteArray()))
      .toString()
    return GeneratedMutationFixture(bytes, canonical, manifest)
  }

  private fun generatedMutationIndex(seed: Int, upperBound: Int): Int =
    (((seed.toLong() and 0xffff_ffffL) * 1_103_515_245L + 12_345L) % upperBound).toInt()

  private fun generatedMutationSha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private data class GeneratedMutationFixture(
    val bytes: ByteArray,
    val canonical: String,
    val manifest: String
  )
}
