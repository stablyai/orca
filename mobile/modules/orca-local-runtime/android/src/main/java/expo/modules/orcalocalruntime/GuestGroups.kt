package expo.modules.orcalocalruntime

import java.io.File

/**
 * The guest inherits the app's Android supplementary groups (inet, all_aNNN, ...), which Ubuntu's
 * /etc/group has never heard of, so every login shell prints "groups: cannot find name for group ID".
 * The app uid — and so these gids — change on reinstall, hence this runs before every start.
 */
object GuestGroups {
  fun register(paths: LocalRuntimePaths, statusFile: File = File("/proc/self/status")) {
    val groupFile = File(paths.rootfs, "etc/group")
    if (!groupFile.isFile) return
    val gids = parseGroups(statusFile.readLines())
    val missing = missingEntries(groupFile.readLines(), gids)
    if (missing.isNotEmpty()) groupFile.appendText(missing.joinToString("\n", postfix = "\n"))
  }

  internal fun parseGroups(statusLines: List<String>): List<Int> =
    statusLines.firstOrNull { it.startsWith("Groups:") }
      ?.removePrefix("Groups:")
      ?.trim()
      ?.split(Regex("\\s+"))
      ?.mapNotNull { it.toIntOrNull() }
      ?: emptyList()

  internal fun missingEntries(groupLines: List<String>, gids: List<Int>): List<String> {
    val known = groupLines.mapNotNull { it.split(':').getOrNull(2)?.toIntOrNull() }.toSet()
    return gids.distinct().filter { it !in known }.map { "aid_$it:x:$it:" }
  }
}
