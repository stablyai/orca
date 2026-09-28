package expo.modules.orcalocalruntime

import android.system.Os
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/** Unpacks a rootfs-style .tar.gz, keeping symlinks and modes that a guest Linux userland needs. */
object TarGzExtractor {
  private const val PERMISSION_BITS = 0x1ff // 0777; setuid/setgid mean nothing under proot
  private const val OWNER_RW = 0x180 // 0600
  private const val OWNER_RWX = 0x1c0 // 0700

  fun extract(input: InputStream, destination: File, onEntry: (String) -> Unit = {}) {
    destination.mkdirs()
    val deferredHardLinks = mutableListOf<Pair<File, File>>()
    TarArchiveInputStream(GzipCompressorInputStream(BufferedInputStream(input))).use { tar ->
      while (true) {
        val entry = tar.nextEntry ?: break
        val target = resolveInside(destination, entry.name) ?: continue
        onEntry(entry.name)
        when {
          entry.isDirectory -> {
            target.mkdirs()
            Os.chmod(target.path, (entry.mode and PERMISSION_BITS) or OWNER_RWX)
          }
          entry.isSymbolicLink -> {
            target.parentFile?.mkdirs()
            removeExisting(target)
            // Guest-absolute targets are resolved by proot, so they are kept verbatim.
            Os.symlink(entry.linkName, target.path)
          }
          entry.isLink -> {
            val source = resolveInside(destination, entry.linkName) ?: continue
            deferredHardLinks += target to source
          }
          entry.isFile -> {
            target.parentFile?.mkdirs()
            removeExisting(target)
            FileOutputStream(target).use { tar.copyTo(it) }
            Os.chmod(target.path, (entry.mode and PERMISSION_BITS) or OWNER_RW)
          }
          // Device nodes and FIFOs cannot be created unprivileged; proot binds the host /dev instead.
          else -> Unit
        }
      }
    }
    // Why copies: link(2) is denied in app data on Android, and a copy is observably the same file to the guest.
    for ((link, source) in deferredHardLinks) {
      if (!source.isFile) continue
      link.parentFile?.mkdirs()
      removeExisting(link)
      source.copyTo(link)
      Os.chmod(link.path, Os.stat(source.path).st_mode and PERMISSION_BITS)
    }
  }

  /** Returns null for any entry that would land outside [root] (`..` segments or absolute names). */
  internal fun resolveInside(root: File, name: String): File? {
    val segments = name.split('/').filter { it.isNotEmpty() && it != "." }
    if (segments.isEmpty() || segments.any { it == ".." }) return null
    return File(root, segments.joinToString("/"))
  }

  private fun removeExisting(file: File) {
    try {
      Os.remove(file.path)
    } catch (_: Exception) {
      // Nothing there yet.
    }
  }
}
