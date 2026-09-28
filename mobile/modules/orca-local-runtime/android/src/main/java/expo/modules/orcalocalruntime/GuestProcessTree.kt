package expo.modules.orcalocalruntime

import android.os.Process
import java.io.File

/**
 * Signals the proot → orcad → daemon → PTY tree as a whole. SIGTERM to proot alone kills proot
 * before `--kill-on-exit` runs, orphaning orcad, which then holds its instance lock so every later
 * start exits 78. Only processes of this app's own uid are visible to signal, which is the scope.
 */
object GuestProcessTree {
  private const val SIGKILL = 9
  private const val SIGTERM = 15
  private const val POLL_MS = 100L

  fun terminate(rootPid: Int, graceMs: Long = 5_000) {
    val tree = listOf(rootPid) + descendants(rootPid, readParents())
    signalAll(tree.reversed(), SIGTERM)
    val deadline = System.currentTimeMillis() + graceMs
    while (tree.any(::isAlive) && System.currentTimeMillis() < deadline) {
      Thread.sleep(POLL_MS)
    }
    signalAll(tree.filter(::isAlive), SIGKILL)
  }

  /** Leftovers from an app process that died without stopping its host (crash, force-stop). */
  fun killStrays(rootfsPath: String) {
    val own = Process.myPid()
    val strays = readParents().keys.filter { pid ->
      pid != own && cmdline(pid).let { it.contains(rootfsPath) || it.contains("${LocalRuntimePaths.GUEST_ORCAD_DIR}/") }
    }
    strays.forEach { terminate(it, graceMs = 2_000) }
  }

  internal fun descendants(root: Int, parents: Map<Int, Int>): List<Int> {
    val children = parents.entries.groupBy({ it.value }, { it.key })
    val result = mutableListOf<Int>()
    val queue = ArrayDeque(listOf(root))
    while (queue.isNotEmpty()) {
      for (child in children[queue.removeFirst()].orEmpty()) {
        if (child !in result && child != root) {
          result += child
          queue += child
        }
      }
    }
    return result
  }

  /** `/proc/<pid>/stat` is "pid (comm) state ppid ..."; comm may hold spaces or parens, so split after the last ')'. */
  internal fun parsePpid(stat: String): Int? =
    stat.substringAfterLast(')').trim().split(' ').getOrNull(1)?.toIntOrNull()

  private fun readParents(): Map<Int, Int> =
    File("/proc").listFiles().orEmpty().mapNotNull { dir ->
      val pid = dir.name.toIntOrNull() ?: return@mapNotNull null
      val ppid = try {
        parsePpid(File(dir, "stat").readText())
      } catch (_: Exception) {
        null
      } ?: return@mapNotNull null
      pid to ppid
    }.toMap()

  private fun cmdline(pid: Int): String = try {
    File("/proc/$pid/cmdline").readText().replace('\u0000', ' ')
  } catch (_: Exception) {
    ""
  }

  private fun isAlive(pid: Int): Boolean = File("/proc/$pid").exists()

  private fun signalAll(pids: List<Int>, signal: Int) = pids.forEach { pid ->
    try {
      Process.sendSignal(pid, signal)
    } catch (_: Exception) {
      // Already gone.
    }
  }
}
