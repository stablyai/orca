package expo.modules.mobilewebshell

import java.io.File
import java.io.FileInputStream

internal fun readMobileWebFile(
  file: File,
  withinRoot: File,
  byteLimit: Int,
  overflowCode: String
): ByteArray {
  try {
    requireMobileWebRegularFile(file, withinRoot, overflowCode)
    val bytes = ByteArray(byteLimit + 1)
    var offset = 0
    FileInputStream(file).use { input ->
      while (offset < bytes.size) {
        val read = input.read(bytes, offset, bytes.size - offset)
        if (read <= 0) break
        offset += read
      }
    }
    require(offset <= byteLimit) { overflowCode }
    return bytes.copyOf(offset)
  } catch (error: Exception) {
    if (error is IllegalArgumentException && error.message == overflowCode) throw error
    throw IllegalArgumentException(overflowCode)
  }
}

internal fun requireMobileWebRegularFile(file: File, root: File, errorCode: String) {
  val rootPath = root.absoluteFile.path.trimEnd(File.separatorChar)
  val prefix = rootPath + File.separator
  val filePath = file.absoluteFile.path
  require(filePath.startsWith(prefix)) { errorCode }
  val relativePath = filePath.removePrefix(prefix)
  val expectedPath = File(root.canonicalFile, relativePath).absoluteFile.path
  require(file.canonicalFile.path == expectedPath && file.isFile) { errorCode }
}
