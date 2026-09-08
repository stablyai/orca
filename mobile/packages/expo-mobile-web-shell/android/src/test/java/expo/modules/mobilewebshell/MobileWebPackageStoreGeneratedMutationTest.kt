package expo.modules.mobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.Base64

class MobileWebPackageStoreGeneratedMutationTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun rejectsGeneratedManifestMutations() {
    val store = jvmMobileWebPackageStore(temporary.newFolder())
    val fixture = mobileWebStoreFixture()
    val manifestBytes = fixture.manifestJson.toByteArray(Charsets.UTF_8)

    repeat(256) { iteration ->
      val bytes = manifestBytes.copyOf()
      bytes[generatedMutationIndex(iteration, bytes.size)] = 0
      assertEquals(
        "mobile_web_manifest_invalid",
        assertThrows(IllegalArgumentException::class.java) {
          store.commitGeneration(
            "generated-host",
            fixture.buildId,
            bytes.toString(Charsets.UTF_8)
          )
        }.message
      )
    }
  }

  @Test
  fun rejectsGeneratedAssetMutations() {
    val store = jvmMobileWebPackageStore(temporary.newFolder())
    val fixture = mobileWebStoreFixture()
    val encoded = Base64.getEncoder().encodeToString(fixture.bytes)

    repeat(256) { iteration ->
      val characters = encoded.toCharArray()
      characters[generatedMutationIndex(iteration, characters.size)] = '!'
      assertEquals(
        "mobile_web_staged_asset_invalid",
        assertThrows(IllegalArgumentException::class.java) {
          store.writeStagedAsset(
            "generated-host",
            fixture.buildId,
            "index.html",
            characters.concatToString()
          )
        }.message
      )
    }

    // Bytes that decode but do not match the manifest hash are caught at commit, not at write.
    store.writeStagedAsset(
      "generated-host",
      fixture.buildId,
      "index.html",
      Base64.getEncoder().encodeToString("mismatched payload".toByteArray(Charsets.UTF_8))
    )
    assertEquals(
      "mobile_web_generation_invalid",
      assertThrows(IllegalArgumentException::class.java) {
        store.commitGeneration("generated-host", fixture.buildId, fixture.manifestJson)
      }.message
    )
  }

  @Test
  fun rejectsGeneratedTokenMutations() {
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

  private fun generatedMutationIndex(seed: Int, upperBound: Int): Int =
    (((seed.toLong() and 0xffff_ffffL) * 1_103_515_245L + 12_345L) % upperBound).toInt()
}
