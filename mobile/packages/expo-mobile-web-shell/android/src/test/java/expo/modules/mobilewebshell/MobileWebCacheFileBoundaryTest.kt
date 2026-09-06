package expo.modules.mobilewebshell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class MobileWebCacheFileBoundaryTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun rejectsFilesOutsideTheCacheAndSymbolicLinks() {
    val root = temporary.newFolder("cache")
    val regular = File(root, "regular").apply { writeText("valid") }
    assertArrayEquals(
      "valid".toByteArray(),
      readMobileWebFile(regular, root, 5, "mobile_web_generation_invalid")
    )

    val outside = temporary.newFile("outside").apply { writeText("valid") }
    assertRejected(outside, root)

    val fileLink = File(root, "file-link")
    Files.createSymbolicLink(fileLink.toPath(), outside.toPath())
    assertRejected(fileLink, root)

    val externalDirectory = temporary.newFolder("external-dir")
    File(externalDirectory, "asset").writeText("valid")
    val directoryLink = File(root, "directory-link")
    Files.createSymbolicLink(directoryLink.toPath(), externalDirectory.toPath())
    assertRejected(File(directoryLink, "asset"), root)

    val directory = File(root, "directory").apply { mkdir() }
    assertRejected(directory, root)
    assertRejected(File(root, "missing"), root)
  }

  private fun assertRejected(file: File, root: File) {
    val error = assertThrows(IllegalArgumentException::class.java) {
      readMobileWebFile(file, root, 5, "mobile_web_generation_invalid")
    }
    assertEquals("mobile_web_generation_invalid", error.message)
  }
}
