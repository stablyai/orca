package expo.modules.mobilewebshell

import java.io.File

internal fun removeMobileWebCacheTree(entry: File, withinRoot: File): Boolean {
  val parent = entry.parentFile ?: return false
  if (!isMobileWebUnlinkedPath(parent, withinRoot)) return false
  if (!isMobileWebUnlinkedPath(entry, withinRoot)) return entry.delete()
  if (!entry.exists()) return entry.delete() || !entry.exists()
  if (!entry.isDirectory) return entry.delete()
  val children = entry.listFiles() ?: return false
  if (!children.all { removeMobileWebCacheTree(it, withinRoot) }) return false
  return entry.delete()
}

internal fun mobileWebCacheLogicalByteLength(entry: File, withinRoot: File): Long {
  if (!isMobileWebUnlinkedPath(entry, withinRoot) || !entry.exists()) return 0
  if (entry.isFile) return entry.length()
  if (!entry.isDirectory) return 0
  return entry.listFiles()
    ?.sumOf { mobileWebCacheLogicalByteLength(it, withinRoot) }
    ?: 0
}

internal fun isMobileWebUnlinkedPath(entry: File, withinRoot: File): Boolean {
  val expected = expectedMobileWebCanonicalPath(entry, withinRoot) ?: return false
  return runCatching { entry.canonicalFile.path == expected }.getOrDefault(false)
}

private fun expectedMobileWebCanonicalPath(entry: File, root: File): String? {
  val rootPath = root.absoluteFile.path.trimEnd(File.separatorChar)
  val entryPath = entry.absoluteFile.path
  if (entryPath == rootPath) return runCatching { root.canonicalFile.path }.getOrNull()
  val prefix = rootPath + File.separator
  if (!entryPath.startsWith(prefix)) return null
  val relativePath = entryPath.removePrefix(prefix)
  val components = relativePath.split(File.separatorChar)
  if (components.any { it.isEmpty() || it == "." || it == ".." }) return null
  val canonicalRoot = runCatching { root.canonicalFile }.getOrNull() ?: return null
  return components.fold(canonicalRoot) { parent, component ->
    File(parent, component)
  }.absoluteFile.path
}
