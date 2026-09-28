package expo.modules.orcalocalruntime

import java.io.File

/** Everything the on-device host owns lives under one app-private directory. */
class LocalRuntimePaths(filesDir: File) {
  val root = File(filesDir, "local-runtime")
  val prootBinary = File(root, "proot/proot")
  val prootLoader = File(root, "proot/loader")
  val rootfs = File(root, "rootfs")
  val prootTmp = File(root, "tmp")
  val downloads = File(root, "downloads")
  val orcadDir = File(rootfs, GUEST_ORCAD_DIR.removePrefix("/"))
  val installRecord = File(root, "install.json")

  companion object {
    const val GUEST_ORCAD_DIR = "/opt/orcad"
    // Short on purpose: proot rewrites it to a host path, and unix sockets under it cap at 108 bytes.
    const val GUEST_USER_DATA = "/root/.o"
  }
}
