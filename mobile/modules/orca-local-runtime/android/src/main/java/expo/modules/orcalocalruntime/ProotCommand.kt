package expo.modules.orcalocalruntime

/** Builds the argv/env that run a command inside the Ubuntu rootfs. Pure so it is unit-testable. */
object ProotCommand {
  const val GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  private val BASE_GUEST_ENV = linkedMapOf(
    "HOME" to "/root",
    "USER" to "root",
    "TERM" to "xterm-256color",
    "LANG" to "C.UTF-8",
    "PATH" to GUEST_PATH,
    "DEBIAN_FRONTEND" to "noninteractive"
  )

  fun argv(paths: LocalRuntimePaths, guestArgv: List<String>, guestEnv: Map<String, String> = emptyMap()): List<String> {
    val env = LinkedHashMap(BASE_GUEST_ENV).apply { putAll(guestEnv) }
    return listOf(
      paths.prootBinary.path,
      // Why: the terminal daemon and every PTY are tracees; without this they outlive a stopped host.
      "--kill-on-exit",
      // Why: Android's SELinux policy refuses link(2) in app data, and dpkg/git both hard-link.
      "--link2symlink",
      "-0",
      "-r", paths.rootfs.path,
      "-b", "/dev",
      "-b", "/proc",
      "-b", "/sys",
      "-b", "/dev/urandom:/dev/random",
      "-b", "${paths.prootTmp.path}:/dev/shm",
      "-w", "/root",
      "/usr/bin/env", "-i"
    ) + env.map { (key, value) -> "$key=$value" } + guestArgv
  }

  fun hostEnv(paths: LocalRuntimePaths): Map<String, String> = mapOf(
    "PROOT_TMP_DIR" to paths.prootTmp.path,
    "PROOT_LOADER" to paths.prootLoader.path
  )

  fun orcadArgv(paths: LocalRuntimePaths, port: Int): List<String> = argv(
    paths,
    listOf(
      "${LocalRuntimePaths.GUEST_ORCAD_DIR}/bun-runtime",
      "${LocalRuntimePaths.GUEST_ORCAD_DIR}/orcad.js",
      "--json",
      "--mobile-pairing",
      "--port", port.toString()
    ),
    mapOf("ORCA_USER_DATA" to LocalRuntimePaths.GUEST_USER_DATA)
  )
}
